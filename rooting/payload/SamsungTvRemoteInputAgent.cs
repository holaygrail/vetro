using System;
using System.Collections.Generic;
using System.IO;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading.Tasks;

internal static class SamsungTvRemoteInputAgent
{
    private const string ProtocolVersion = "SAMSUNG-TV-REMOTE/1";
    private const string Libc = "libc";
    private const string VconfApi = "/usr/lib/libvconf.so.0";
    private const string CurrentSourceTypeKey = "memory/system/source_type";
    private const string CurrentFullscreenAppIdKey =
        "memory/appfw/current_fullscreen_appid";
    private const string CurrentPartialAppIdKey =
        "memory/appfw/current_partial_appid";
    private const int ConnectTimeoutMilliseconds = 5000;
    private const int MaximumLineBytes = 64 * 1024;
    private const int OpenReadOnly = 0;
    private const int OpenWriteOnly = 1;
    private const int OpenNonblock = 2048;
    private const int InterruptedSystemCall = 4;
    private const short PollIn = 1;
    private const short PollError = 8;
    private const short PollHangup = 16;
    private const short PollInvalid = 32;
    private const ushort EventSynchronization = 0;
    private const ushort EventKey = 1;
    private const ushort EventMiscellaneous = 4;
    private const ushort MiscellaneousScan = 4;
    private const int KeyMaximum = 0x2ff;
    private const uint EviocGrab = 0x40044590;
    private const uint UiSetEventBit = 0x40045564;
    private const uint UiSetKeyBit = 0x40045565;
    private const uint UiDeviceCreate = 0x00005501;
    private const uint UiDeviceDestroy = 0x00005502;
    private const int UinputUserDeviceSize = 1116;
    private const int UinputNameBytes = 80;
    private const int DeviceBusy = 16;   // EBUSY
    // Vetro diagnostics: dropped-event counting and key-state self-check (no effect on forwarding).
    private const ushort SynchronizationDropped = 3;
    private const int KeyBitmapBytes = (KeyMaximum / 8) + 1;
    private const uint EviocGetKey = 0x80000000u | ((uint)KeyBitmapBytes << 16) | 0x4518u;
    private const int SysnameBytes = 64;
    private const uint UiGetSysname = 0x80000000u | ((uint)SysnameBytes << 16) | 0x552Cu;
    private const int StateCheckMilliseconds = 5000;
    private const int StateHeartbeatMilliseconds = 60000;

    [StructLayout(LayoutKind.Sequential)]
    private struct PollDescriptor
    {
        public int FileDescriptor;
        public short Events;
        public short ReturnedEvents;
    }

    private sealed class InputDevice
    {
        public string Node = "";
        public string Name = "";
        public ushort Bus;
        public ushort Vendor;
        public ushort Product;
        public ushort Version;
    }

    private sealed class PresentationSnapshot
    {
        public string FullscreenApplicationId = "";
        public string PartialApplicationId = "";
    }

    private sealed class UinputForwarder : IDisposable
    {
        private int descriptor = -1;
        private readonly HashSet<ushort> pressedKeys = new HashSet<ushort>();
        private string node;
        public string SysName = "";

        public List<int> TrackedKeys()
        {
            List<int> result = new List<int>();
            foreach (ushort code in pressedKeys)
            {
                result.Add(code);
            }
            result.Sort();
            return result;
        }

        // The evdev node of the forwarded device, e.g. /dev/input/event17 (resolved once via sysfs).
        public string Node()
        {
            if (node == null && SysName.Length != 0)
            {
                try
                {
                    foreach (string entry in Directory.GetDirectories("/sys/class/input/" + SysName))
                    {
                        string name = Path.GetFileName(entry);
                        if (name.StartsWith("event", StringComparison.Ordinal))
                        {
                            node = "/dev/input/" + name;
                            break;
                        }
                    }
                }
                catch (Exception)
                {
                }
            }
            return node;
        }

        public UinputForwarder(InputDevice source)
        {
            descriptor = open("/dev/uinput", OpenWriteOnly | OpenNonblock);
            if (descriptor < 0)
            {
                throw NativeError("open /dev/uinput");
            }
            try
            {
                RequireIoctl(descriptor, UiSetEventBit, EventSynchronization);
                RequireIoctl(descriptor, UiSetEventBit, EventKey);
                for (int code = 0; code <= KeyMaximum; code++)
                {
                    RequireIoctl(descriptor, UiSetKeyBit, code);
                }
                byte[] definition = new byte[UinputUserDeviceSize];
                WriteFixedString(
                    definition,
                    0,
                    UinputNameBytes,
                    "vetro-forwarded-remote");
                WriteUInt16(definition, 80, source.Bus == 0 ? (ushort)6 : source.Bus);
                WriteUInt16(definition, 82, source.Vendor);
                WriteUInt16(definition, 84, source.Product);
                WriteUInt16(definition, 86, source.Version);
                RequireWrite(descriptor, definition);
                if (ioctl_no_argument(descriptor, UiDeviceCreate) != 0)
                {
                    throw NativeError("UI_DEV_CREATE");
                }
                byte[] sysname = new byte[SysnameBytes];
                if (ioctl_buffer(descriptor, UiGetSysname, sysname) >= 0)
                {
                    SysName = Encoding.ASCII.GetString(sysname).TrimEnd('\0');
                    MarkAsRemoteControl();
                }
            }
            catch
            {
                Dispose();
                throw;
            }
        }

        // Upstream 80e37b8 + 97ead62 (0.7.0): the TV's keyrouter gives the Remocon subclass by device name (a list of
        // Samsung remotes); "vetro-forwarded-remote" is not on it, so the copy is taken for a keyboard and the on-screen
        // keyboard hides on its first key (upstream issue #143). Tizen 9 can be told the subclass with enlightenment_info
        // (-input_subtype_set exists on the S90C, 2220.4). One fixed outcome line goes to the per-node log.
        private void MarkAsRemoteControl()
        {
            if (SysName.Length == 0 || SysName.IndexOf('/') >= 0)
            {
                return;
            }
            Task.Run(() =>
            {
                bool asked = false;
                try
                {
                    for (int attempt = 0; attempt < 12; attempt++)
                    {
                        System.Threading.Thread.Sleep(250);
                        string eventNode = Node();
                        if (eventNode == null)
                        {
                            continue;
                        }
                        if (!File.Exists("/usr/bin/enlightenment_info"))
                        {
                            Note("remocon subtype: no tool");
                            return;
                        }
                        asked = true;
                        using (System.Diagnostics.Process process = new System.Diagnostics.Process())
                        {
                            process.StartInfo.FileName = "/usr/bin/enlightenment_info";
                            process.StartInfo.Arguments = "-input_subtype_set " + eventNode + " Remocon";
                            process.StartInfo.UseShellExecute = false;
                            process.StartInfo.RedirectStandardOutput = true;
                            process.StartInfo.RedirectStandardError = true;
                            process.Start();
                            string output = process.StandardOutput.ReadToEnd() + process.StandardError.ReadToEnd();
                            process.WaitForExit(5000);
                            if (output.Contains("Success"))
                            {
                                Note("remocon subtype: set " + eventNode);
                                return;
                            }
                            if (output.Contains("unknown option"))
                            {
                                Note("remocon subtype: unsupported");
                                return;
                            }
                        }
                    }
                    Note(asked ? "remocon subtype: refused" : "remocon subtype: no node");
                }
                catch (Exception)
                {
                    Note("remocon subtype: failed");
                }
            });
        }

        public void Forward(byte[] inputEvent)
        {
            RequireWrite(descriptor, inputEvent);
            int typeOffset = IntPtr.Size == 8 ? 16 : 8;
            int codeOffset = typeOffset + 2;
            int valueOffset = codeOffset + 2;
            ushort type = BitConverter.ToUInt16(inputEvent, typeOffset);
            if (type != EventKey)
            {
                return;
            }
            ushort code = BitConverter.ToUInt16(inputEvent, codeOffset);
            int value = BitConverter.ToInt32(inputEvent, valueOffset);
            if (value == 0)
            {
                pressedKeys.Remove(code);
            }
            else
            {
                pressedKeys.Add(code);
            }
        }

        public void Dispose()
        {
            int current = descriptor;
            descriptor = -1;
            if (current < 0)
            {
                return;
            }
            try
            {
                ReleasePressedKeys(current);
            }
            catch (Exception exception)
            {
                Console.Error.WriteLine(
                    "failed to release forwarded remote keys: " + exception.Message);
            }
            ioctl_no_argument(current, UiDeviceDestroy);
            close(current);
        }

        private void ReleasePressedKeys(int current)
        {
            int eventSize = IntPtr.Size == 8 ? 24 : 16;
            int typeOffset = IntPtr.Size == 8 ? 16 : 8;
            int codeOffset = typeOffset + 2;
            int valueOffset = codeOffset + 2;
            foreach (ushort code in pressedKeys)
            {
                byte[] release = new byte[eventSize];
                WriteUInt16(release, typeOffset, EventKey);
                WriteUInt16(release, codeOffset, code);
                WriteInt32(release, valueOffset, 0);
                RequireWrite(current, release);
            }
            if (pressedKeys.Count != 0)
            {
                byte[] synchronization = new byte[eventSize];
                WriteUInt16(
                    synchronization,
                    typeOffset,
                    EventSynchronization);
                RequireWrite(current, synchronization);
                pressedKeys.Clear();
            }
        }
    }

    [DllImport(Libc, SetLastError = true)]
    private static extern int open(string path, int flags);

    [DllImport(Libc, SetLastError = true)]
    private static extern int read(int descriptor, byte[] buffer, int count);

    [DllImport(Libc, SetLastError = true)]
    private static extern int write(int descriptor, byte[] buffer, int count);

    [DllImport(Libc, SetLastError = true)]
    private static extern int close(int descriptor);

    [DllImport(Libc, SetLastError = true)]
    private static extern int poll(
        [In, Out] PollDescriptor[] descriptors,
        uint count,
        int timeout);

    [DllImport(Libc, SetLastError = true, EntryPoint = "ioctl")]
    private static extern int ioctl_integer(int descriptor, uint request, int value);

    [DllImport(Libc, SetLastError = true, EntryPoint = "ioctl")]
    private static extern int ioctl_no_argument(int descriptor, uint request);

    [DllImport(Libc, SetLastError = true, EntryPoint = "ioctl")]
    private static extern int ioctl_buffer(int descriptor, uint request, byte[] buffer);

    [DllImport(Libc)]
    private static extern int getpid();

    [DllImport(Libc)]
    private static extern int getuid();

    [DllImport(Libc)]
    private static extern int getgid();

    [DllImport(VconfApi, EntryPoint = "vconf_get_int")]
    private static extern int VconfGetInt(string key, out int value);

    [DllImport(VconfApi, EntryPoint = "vconf_get_str")]
    private static extern IntPtr VconfGetString(string key);

    [DllImport(Libc)]
    private static extern void free(IntPtr pointer);

    public static int Main(string[] arguments)
    {
        byte[] secret = null;
        try
        {
            if (arguments.Length != 8)
            {
                throw new ArgumentException(
                    "usage: SamsungTvRemoteInputAgent.dll CALLBACK_IPV4 PORT "
                    + "TOKEN_FILE DEVICE_NAME TRANSPORT MODEL MODE BLOCKED_TOKENS");
            }
            int port;
            if (!int.TryParse(arguments[1], out port) || port < 1 || port > 65535)
            {
                throw new ArgumentException("invalid callback port");
            }
            bool filter;
            if (arguments[6] == "observe")
            {
                filter = false;
            }
            else if (arguments[6] == "filter")
            {
                filter = true;
            }
            else
            {
                throw new ArgumentException("remote-input mode must be observe or filter");
            }
            HashSet<string> blocked = ParseTokens(arguments[7]);
            if (!filter && blocked.Count != 0)
            {
                throw new ArgumentException("observe mode cannot block input tokens");
            }
            secret = ReadAndRemoveSecret(arguments[2]);
            if (secret.Length < 32)
            {
                throw new InvalidDataException(
                    "remote-input secret must contain at least 32 bytes");
            }
            Run(
                arguments[0],
                port,
                secret,
                arguments[3],
                arguments[4],
                arguments[5],
                filter,
                blocked);
            return 0;
        }
        catch (Exception exception)
        {
            Console.Error.WriteLine(
                exception.GetType().Name + ": " + exception.Message);
            return 1;
        }
        finally
        {
            if (secret != null)
            {
                Array.Clear(secret, 0, secret.Length);
            }
        }
    }

    private static void WaitForNoKeyDown(int descriptor)
    {
        byte[] keys = new byte[KeyBitmapBytes];
        for (int attempt = 0; attempt < 20; attempt++)
        {
            Array.Clear(keys, 0, keys.Length);
            if (ioctl_buffer(descriptor, EviocGetKey, keys) < 0)
            {
                return;   // the driver cannot say: grab as before
            }
            bool down = false;
            for (int i = 0; i < keys.Length && !down; i++)
            {
                down = keys[i] != 0;
            }
            if (!down)
            {
                return;
            }
            if (attempt == 0)
            {
                Note("grab: waiting for a held key to be released");
            }
            System.Threading.Thread.Sleep(50);
        }
        Note("grab: a key was still held after 1 s, grabbing anyway");
    }

    private static void Note(string message)
    {
        Console.Error.WriteLine(
            DateTime.UtcNow.ToString("yyyy-MM-ddTHH:mm:ss.fffZ", System.Globalization.CultureInfo.InvariantCulture)
            + " " + message);
    }

    private static void Run(
        string host,
        int port,
        byte[] secret,
        string deviceName,
        string transport,
        string model,
        bool filter,
        HashSet<string> blocked)
    {
        InputDevice device = FindInputDevice(deviceName);
        if (device == null)
        {
            throw new InvalidOperationException(
                "input device not found: " + deviceName);
        }
        using (TcpClient client = new TcpClient())
        {
            Task connection = client.ConnectAsync(host, port);
            if (!connection.Wait(ConnectTimeoutMilliseconds))
            {
                throw new TimeoutException("remote-input callback timed out");
            }
            connection.GetAwaiter().GetResult();
            client.NoDelay = true;
            client.SendTimeout = 2000;
            client.Client.SetSocketOption(
                SocketOptionLevel.Socket,
                SocketOptionName.KeepAlive,
                true);
            using (NetworkStream stream = client.GetStream())
            {
                // Upstream fc89023: the service writes its hello at once; a helper whose service never speaks (or is
                // gone) must not sit there for ever, so the first read gives up after 10 s.
                client.ReceiveTimeout = 10000;
                string hello = ReadLine(stream);
                client.ReceiveTimeout = 0;
                string[] helloFields = hello.Split('\t');
                if (helloFields.Length != 2 || helloFields[0] != ProtocolVersion)
                {
                    throw new InvalidDataException("invalid remote-input hello");
                }
                byte[] nonce = HexDecode(helloFields[1]);
                if (nonce.Length != 32)
                {
                    throw new InvalidDataException("invalid challenge length");
                }
                int inputDescriptor = open(device.Node, OpenReadOnly | OpenNonblock);
                if (inputDescriptor < 0)
                {
                    throw NativeError("open " + device.Node);
                }
                UinputForwarder forwarder = null;
                bool grabbed = false;
                try
                {
                    if (filter)
                    {
                        forwarder = new UinputForwarder(device);
                        // Upstream 1d00aa0: a key held down at the moment of the grab is released through the copy while the
                        // remote still counts it as down, and Tizen 9 drops a release whose code is down on another device,
                        // so the key keeps reading as held (a candidate for the 2026-11-08 volume drop). Wait up to 1 s.
                        WaitForNoKeyDown(inputDescriptor);
                        // Upstream fc89023: EBUSY while a helper of an earlier start still lets go of the remote; the service
                        // ends a stale helper of the same node first, a short retry covers the rest.
                        int grab = ioctl_integer(inputDescriptor, EviocGrab, 1);
                        for (int attempt = 0; grab != 0 && Marshal.GetLastWin32Error() == DeviceBusy && attempt < 5; attempt++)
                        {
                            System.Threading.Thread.Sleep(300);
                            grab = ioctl_integer(inputDescriptor, EviocGrab, 1);
                        }
                        if (grab != 0)
                        {
                            throw NativeError("EVIOCGRAB " + device.Node);
                        }
                        grabbed = true;
                    }
                    WriteAuthenticated(
                        stream,
                        nonce,
                        secret,
                        string.Join(
                            "\t",
                            "AUTH",
                            getpid().ToString(),
                            getuid().ToString(),
                            getgid().ToString(),
                            Base64(device.Name),
                            Base64(device.Node),
                            Base64(transport),
                            Base64(model),
                            filter ? "filter" : "observe"));
                    ForwardEvents(
                        client,
                        stream,
                        inputDescriptor,
                        device,
                        transport,
                        model,
                        filter,
                        blocked,
                        forwarder,
                        nonce,
                        secret);
                }
                finally
                {
                    if (forwarder != null)
                    {
                        forwarder.Dispose();
                    }
                    if (grabbed)
                    {
                        ioctl_integer(inputDescriptor, EviocGrab, 0);
                    }
                    close(inputDescriptor);
                }
            }
        }
    }

    private static void ForwardEvents(
        TcpClient client,
        Stream stream,
        int inputDescriptor,
        InputDevice device,
        string transport,
        string model,
        bool filter,
        HashSet<string> blocked,
        UinputForwarder forwarder,
        byte[] nonce,
        byte[] secret)
    {
        int eventSize = IntPtr.Size == 8 ? 24 : 16;
        int typeOffset = IntPtr.Size == 8 ? 16 : 8;
        int codeOffset = typeOffset + 2;
        int valueOffset = codeOffset + 2;
        Dictionary<int, string> keyNames = ReadKeyNames();
        Dictionary<ushort, bool> pressedBlocked = new Dictionary<ushort, bool>();
        long sequence = 0;
        int? scanCode = null;
        byte[] buffer = new byte[eventSize];
        PollDescriptor[] descriptors = new PollDescriptor[]
        {
            new PollDescriptor { FileDescriptor = inputDescriptor, Events = PollIn },
            new PollDescriptor
            {
                FileDescriptor = client.Client.Handle.ToInt32(),
                Events = PollIn,
            },
        };
        StateMonitor monitor = new StateMonitor(device.Node, inputDescriptor, forwarder);
        while (true)
        {
            descriptors[0].ReturnedEvents = 0;
            descriptors[1].ReturnedEvents = 0;
            int ready = poll(descriptors, 2, monitor.MillisecondsUntilCheck());
            if (ready >= 0)
            {
                string state = monitor.Check(pressedBlocked);
                if (state != null)
                {
                    WriteAuthenticated(
                        stream,
                        nonce,
                        secret,
                        "STATE\t" + Convert.ToBase64String(Encoding.UTF8.GetBytes(state)));
                }
            }
            if (ready < 0)
            {
                if (Marshal.GetLastWin32Error() == InterruptedSystemCall)
                {
                    continue;
                }
                throw NativeError("poll remote input");
            }
            if ((descriptors[1].ReturnedEvents
                    & (PollError | PollHangup | PollInvalid)) != 0)
            {
                return;
            }
            if ((descriptors[1].ReturnedEvents & PollIn) != 0)
            {
                byte[] probe = new byte[1];
                int count = client.Client.Receive(probe, 0, 1, SocketFlags.Peek);
                if (count == 0)
                {
                    return;
                }
                throw new InvalidDataException(
                    "remote-input host sent unexpected data");
            }
            if ((descriptors[0].ReturnedEvents
                    & (PollError | PollHangup | PollInvalid)) != 0)
            {
                throw new IOException("remote input device disconnected");
            }
            if ((descriptors[0].ReturnedEvents & PollIn) == 0)
            {
                continue;
            }
            while (true)
            {
                int count = read(inputDescriptor, buffer, buffer.Length);
                if (count != eventSize)
                {
                    break;
                }
                ushort type = BitConverter.ToUInt16(buffer, typeOffset);
                ushort code = BitConverter.ToUInt16(buffer, codeOffset);
                int value = BitConverter.ToInt32(buffer, valueOffset);
                if (type == EventMiscellaneous && code == MiscellaneousScan)
                {
                    scanCode = value;
                }
                if (type == EventSynchronization && code == SynchronizationDropped)
                {
                    monitor.Dropped();
                }
                string key;
                if (!keyNames.TryGetValue(code, out key))
                {
                    key = "";
                }
                bool block = false;
                if (type == EventKey)
                {
                    bool first = blocked.Contains(code.ToString())
                        || (!string.IsNullOrEmpty(key) && blocked.Contains(key));
                    bool original;
                    if (value == 1)
                    {
                        block = first;
                        pressedBlocked[code] = block;
                    }
                    else if (pressedBlocked.TryGetValue(code, out original))
                    {
                        block = original;
                    }
                    else
                    {
                        block = first;
                    }
                }
                if (filter
                    && !block
                    && (type == EventKey || type == EventSynchronization))
                {
                    forwarder.Forward(buffer);
                }
                if (type == EventKey)
                {
                    sequence++;
                    WriteAuthenticated(
                        stream,
                        nonce,
                        secret,
                        "EVENT\t"
                        + sequence
                        + "\t"
                        + Convert.ToBase64String(
                            Encoding.UTF8.GetBytes(
                                EventJson(
                                    sequence,
                                    buffer,
                                    device,
                                    transport,
                                    model,
                                    filter,
                                    code,
                                    value,
                                    key,
                                    block,
                                    scanCode))));
                    if (value == 0)
                    {
                        pressedBlocked.Remove(code);
                    }
                }
                if (type == EventSynchronization)
                {
                    scanCode = null;
                }
            }
        }
    }

    private static string EventJson(
        long sequence,
        byte[] buffer,
        InputDevice device,
        string transport,
        string model,
        bool filter,
        ushort code,
        int value,
        string key,
        bool blocked,
        int? scanCode)
    {
        long seconds = IntPtr.Size == 8
            ? BitConverter.ToInt64(buffer, 0)
            : BitConverter.ToInt32(buffer, 0);
        long microseconds = IntPtr.Size == 8
            ? BitConverter.ToInt64(buffer, 8)
            : BitConverter.ToInt32(buffer, 4);
        int sourceType = ReadCurrentSourceType();
        PresentationSnapshot presentation = ReadPresentationSnapshot();
        return "{"
            + "\"event\":\"input\""
            + ",\"sequence\":" + sequence
            + ",\"node\":\"" + EscapeJson(device.Node) + "\""
            + ",\"device\":\"" + EscapeJson(device.Name) + "\""
            + ",\"transport\":\"" + EscapeJson(transport) + "\""
            + ",\"model\":\"" + EscapeJson(model) + "\""
            + ",\"mode\":\"" + (filter ? "filter" : "observe") + "\""
            + ",\"time_seconds\":" + seconds
            + ",\"time_microseconds\":" + microseconds
            + ",\"type\":1"
            + ",\"code\":" + code
            + ",\"value\":" + value
            + ",\"type_name\":\"EV_KEY\""
            + ",\"key\":\"" + EscapeJson(key) + "\""
            + ",\"action\":\"" + ActionName(value) + "\""
            + ",\"decision\":\"" + (blocked ? "blocked" : "native") + "\""
            + (scanCode.HasValue
                ? ",\"scan_code\":" + scanCode.Value
                    + ",\"scan_code_hex\":\"0x"
                    + unchecked((uint)scanCode.Value).ToString("X8") + "\""
                : "")
            + (sourceType >= 0
                ? ",\"tv_source\":\"" + SourceName(sourceType) + "\""
                    + ",\"tv_source_type\":" + sourceType
                : "")
            + (presentation != null
                ? ",\"tv_fullscreen_appid\":\""
                    + EscapeJson(presentation.FullscreenApplicationId)
                    + "\",\"tv_partial_appid\":\""
                    + EscapeJson(presentation.PartialApplicationId)
                    + "\""
                : "")
            + "}";
    }

    private static int ReadCurrentSourceType()
    {
        int sourceType;
        return VconfGetInt(CurrentSourceTypeKey, out sourceType) == 0
            ? sourceType
            : -1;
    }

    private static PresentationSnapshot ReadPresentationSnapshot()
    {
        string fullscreen;
        string partial;
        if (!TryReadVconfString(CurrentFullscreenAppIdKey, out fullscreen)
            || !TryReadVconfString(CurrentPartialAppIdKey, out partial))
        {
            return null;
        }
        return new PresentationSnapshot
        {
            FullscreenApplicationId = fullscreen,
            PartialApplicationId = partial,
        };
    }

    private static bool TryReadVconfString(string key, out string value)
    {
        IntPtr pointer = VconfGetString(key);
        if (pointer == IntPtr.Zero)
        {
            value = "";
            return false;
        }
        try
        {
            value = Marshal.PtrToStringAnsi(pointer) ?? "";
            return true;
        }
        finally
        {
            free(pointer);
        }
    }

    private static string SourceName(int sourceType)
    {
        switch (sourceType)
        {
            case 13:
                return "HDMI1";
            case 14:
                return "HDMI2";
            case 15:
                return "HDMI3";
            case 16:
                return "HDMI4";
            default:
                return "TV";
        }
    }

    private static string ActionName(int value)
    {
        switch (value)
        {
            case 0:
                return "up";
            case 1:
                return "down";
            case 2:
                return "repeat";
            default:
                return value.ToString();
        }
    }

    private static InputDevice FindInputDevice(string expectedName)
    {
        // Vetro extension: bind an exact node as well as its registered name.
        string expectedNode = null;
        int separator = expectedName.LastIndexOf("@/dev/input/");
        if (separator >= 0)
        {
            expectedNode = expectedName.Substring(separator + 1);
            expectedName = expectedName.Substring(0, separator);
            if (!Regex.IsMatch(expectedNode, "^/dev/input/event[0-9]+$"))
                throw new ArgumentException("invalid exact input node");
        }
        if (!File.Exists("/proc/bus/input/devices"))
        {
            return null;
        }
        string text = File.ReadAllText("/proc/bus/input/devices");
        foreach (string block in Regex.Split(text.Trim(), "\\n\\s*\\n"))
        {
            Match nameMatch = Regex.Match(block, "N: Name=\\\"(.*)\\\"");
            if (!nameMatch.Success || nameMatch.Groups[1].Value != expectedName)
            {
                continue;
            }
            Match eventMatch = Regex.Match(block, "\\bevent[0-9]+\\b");
            if (!eventMatch.Success)
            {
                continue;
            }
            Match identity = Regex.Match(
                block,
                "Bus=([0-9A-Fa-f]+) Vendor=([0-9A-Fa-f]+) "
                + "Product=([0-9A-Fa-f]+) Version=([0-9A-Fa-f]+)");
            InputDevice device = new InputDevice();
            device.Name = expectedName;
            device.Node = "/dev/input/" + eventMatch.Value;
            if (expectedNode != null && device.Node != expectedNode) continue;
            if (identity.Success)
            {
                device.Bus = ParseHex16(identity.Groups[1].Value);
                device.Vendor = ParseHex16(identity.Groups[2].Value);
                device.Product = ParseHex16(identity.Groups[3].Value);
                device.Version = ParseHex16(identity.Groups[4].Value);
            }
            return device;
        }
        return null;
    }

    private static Dictionary<int, string> ReadKeyNames()
    {
        Dictionary<int, string> result = new Dictionary<int, string>();
        AddFallbackKeyNames(result);
        string path = "/usr/share/X11/xkb/tizen_key_layout.txt.tv";
        if (!File.Exists(path))
        {
            return result;
        }
        foreach (string line in File.ReadLines(path))
        {
            string[] parts = Regex.Split(line.Trim(), "\\s+");
            int code;
            if (parts.Length >= 2 && int.TryParse(parts[1], out code))
            {
                result[code] = parts[0];
            }
        }
        return result;
    }

    private static void AddFallbackKeyNames(Dictionary<int, string> result)
    {
        result[1] = "XF86Back";
        result[28] = "Return";
        result[59] = "XF86Red";
        result[60] = "XF86Green";
        result[61] = "XF86Yellow";
        result[62] = "XF86Blue";
        result[63] = "XF86Home";
        result[66] = "XF86AudioMute";
        result[67] = "XF86AudioLowerVolume";
        result[68] = "XF86AudioRaiseVolume";
        result[103] = "Up";
        result[105] = "Left";
        result[106] = "Right";
        result[108] = "Down";
        result[116] = "XF86PowerOff";
        result[127] = "XF86SimpleMenu";
        result[174] = "XF86Exit";
        result[188] = "XF86Info";
        result[213] = "XF86Caption";
    }

    private static HashSet<string> ParseTokens(string value)
    {
        HashSet<string> result = new HashSet<string>(StringComparer.Ordinal);
        foreach (string token in (value ?? "").Split(','))
        {
            string normalized = token.Trim();
            if (normalized.Length > 0)
            {
                result.Add(normalized);
            }
        }
        return result;
    }

    private static byte[] ReadAndRemoveSecret(string path)
    {
        try
        {
            return Convert.FromBase64String(File.ReadAllText(path).Trim());
        }
        finally
        {
            try
            {
                File.Delete(path);
            }
            catch
            {
            }
        }
    }

    private static void WriteAuthenticated(
        Stream stream,
        byte[] nonce,
        byte[] secret,
        string payload)
    {
        string line = payload + "\t" + Authenticate(nonce, secret, payload);
        byte[] bytes = Encoding.UTF8.GetBytes(line + "\n");
        stream.Write(bytes, 0, bytes.Length);
        stream.Flush();
    }

    private static string Authenticate(
        byte[] nonce,
        byte[] secret,
        string payload)
    {
        byte[] payloadBytes = Encoding.UTF8.GetBytes(payload);
        byte[] message = new byte[nonce.Length + 1 + payloadBytes.Length];
        Buffer.BlockCopy(nonce, 0, message, 0, nonce.Length);
        Buffer.BlockCopy(
            payloadBytes,
            0,
            message,
            nonce.Length + 1,
            payloadBytes.Length);
        using (HMACSHA256 hmac = new HMACSHA256(secret))
        {
            return HexEncode(hmac.ComputeHash(message));
        }
    }

    private static string ReadLine(Stream stream)
    {
        using (MemoryStream buffer = new MemoryStream())
        {
            while (buffer.Length <= MaximumLineBytes)
            {
                int value = stream.ReadByte();
                if (value < 0)
                {
                    throw new EndOfStreamException(
                        "remote-input host disconnected");
                }
                if (value == '\n')
                {
                    return Encoding.UTF8.GetString(buffer.ToArray()).TrimEnd('\r');
                }
                buffer.WriteByte((byte)value);
            }
        }
        throw new InvalidDataException("remote-input frame exceeds size limit");
    }

    private static void RequireIoctl(int descriptor, uint request, int value)
    {
        if (ioctl_integer(descriptor, request, value) != 0)
        {
            throw NativeError("ioctl 0x" + request.ToString("x"));
        }
    }

    private static void RequireWrite(int descriptor, byte[] buffer)
    {
        int count = write(descriptor, buffer, buffer.Length);
        if (count != buffer.Length)
        {
            throw NativeError(
                "write returned " + count + ", expected " + buffer.Length);
        }
    }

    private static Exception NativeError(string operation)
    {
        return new IOException(
            operation + " failed with errno " + Marshal.GetLastWin32Error());
    }

    private static void WriteFixedString(
        byte[] target,
        int offset,
        int length,
        string value)
    {
        byte[] source = Encoding.UTF8.GetBytes(value ?? "");
        Buffer.BlockCopy(source, 0, target, offset, Math.Min(source.Length, length - 1));
    }

    private static void WriteUInt16(byte[] target, int offset, ushort value)
    {
        byte[] bytes = BitConverter.GetBytes(value);
        Buffer.BlockCopy(bytes, 0, target, offset, bytes.Length);
    }

    private static void WriteInt32(byte[] target, int offset, int value)
    {
        byte[] bytes = BitConverter.GetBytes(value);
        Buffer.BlockCopy(bytes, 0, target, offset, bytes.Length);
    }

    private static ushort ParseHex16(string value)
    {
        return Convert.ToUInt16(value, 16);
    }

    private static string Base64(string value)
    {
        return Convert.ToBase64String(Encoding.UTF8.GetBytes(value ?? ""));
    }

    private static string EscapeJson(string value)
    {
        StringBuilder builder = new StringBuilder();
        foreach (char character in value ?? "")
        {
            switch (character)
            {
                case '"':
                case '\\':
                    builder.Append('\\').Append(character);
                    break;
                case '\n':
                    builder.Append("\\n");
                    break;
                case '\r':
                    builder.Append("\\r");
                    break;
                case '\t':
                    builder.Append("\\t");
                    break;
                default:
                    builder.Append(character);
                    break;
            }
        }
        return builder.ToString();
    }

    private static string HexEncode(byte[] bytes)
    {
        StringBuilder output = new StringBuilder(bytes.Length * 2);
        foreach (byte value in bytes)
        {
            output.Append(value.ToString("x2"));
        }
        return output.ToString();
    }

    private static byte[] HexDecode(string value)
    {
        if ((value.Length & 1) != 0)
        {
            throw new InvalidDataException("invalid hexadecimal length");
        }
        byte[] output = new byte[value.Length / 2];
        for (int index = 0; index < output.Length; index++)
        {
            output[index] = Convert.ToByte(value.Substring(index * 2, 2), 16);
        }
        return output;
    }

    // Vetro diagnostics. Every 5 s compares the keys the kernel reports as held on the source
    // remote, on the forwarded uinput device and in the forwarder's own bookkeeping, and counts
    // SYN_DROPPED (lost events). A difference that persists over two checks is reported as stuck.
    // Reports go out as STATE frames on change and every 60 s, and changes are logged to stderr.
    private sealed class StateMonitor
    {
        private readonly string sourceNode;
        private readonly int sourceDescriptor;
        private readonly UinputForwarder forwarder;
        private long nextCheck;
        private long lastReport;
        private long checks;
        private long dropped;
        private double lastDroppedAt;
        private int mismatches;
        private bool stuck;
        private double stuckSince;
        private string lastSignature = "";

        public StateMonitor(string node, int descriptor, UinputForwarder forwarder)
        {
            sourceNode = node;
            sourceDescriptor = descriptor;
            this.forwarder = forwarder;
            nextCheck = Environment.TickCount64 + StateCheckMilliseconds;
            lastReport = Environment.TickCount64;
        }

        public int MillisecondsUntilCheck()
        {
            long wait = nextCheck - Environment.TickCount64;
            return wait <= 0 ? 0 : (int)Math.Min(wait, StateCheckMilliseconds);
        }

        public void Dropped()
        {
            dropped++;
            lastDroppedAt = Now();
            Log("SYN_DROPPED on " + sourceNode + " (total " + dropped + ")");
        }

        public string Check(Dictionary<ushort, bool> pressedBlocked)
        {
            long now = Environment.TickCount64;
            if (now < nextCheck)
            {
                return null;
            }
            nextCheck = now + StateCheckMilliseconds;
            checks++;
            List<int> source = ReadKeys(sourceDescriptor);
            List<int> forwarded = null;
            List<int> tracked = null;
            string forwardedNode = null;
            List<int> blockedHeld = new List<int>();
            foreach (KeyValuePair<ushort, bool> entry in pressedBlocked)
            {
                if (entry.Value)
                {
                    blockedHeld.Add(entry.Key);
                }
            }
            blockedHeld.Sort();
            bool mismatch = false;
            if (forwarder != null)
            {
                tracked = forwarder.TrackedKeys();
                forwardedNode = forwarder.Node();
                if (forwardedNode != null)
                {
                    int descriptor = open(forwardedNode, OpenReadOnly | OpenNonblock);
                    if (descriptor >= 0)
                    {
                        forwarded = ReadKeys(descriptor);
                        close(descriptor);
                    }
                }
                List<int> expected = new List<int>();
                if (source != null)
                {
                    foreach (int code in source)
                    {
                        if (!blockedHeld.Contains(code))
                        {
                            expected.Add(code);
                        }
                    }
                }
                mismatch = source == null || forwarded == null
                    || !SameKeys(expected, forwarded) || !SameKeys(tracked, forwarded);
            }
            mismatches = mismatch ? mismatches + 1 : 0;
            bool nowStuck = mismatches >= 2;
            if (nowStuck && !stuck)
            {
                stuckSince = Now();
            }
            stuck = nowStuck;
            string signature = (stuck ? "stuck" : "ok") + "|" + dropped;
            bool changed = signature != lastSignature;
            if (!changed && now - lastReport < StateHeartbeatMilliseconds)
            {
                return null;
            }
            string json = "{"
                + "\"event\":\"state\""
                + ",\"node\":\"" + EscapeJson(sourceNode) + "\""
                + ",\"ts\":" + Now().ToString("F3", System.Globalization.CultureInfo.InvariantCulture)
                + ",\"checks\":" + checks
                + ",\"dropped\":" + dropped
                + ",\"last_dropped_at\":" + lastDroppedAt.ToString("F3", System.Globalization.CultureInfo.InvariantCulture)
                + ",\"source\":" + JsonKeys(source)
                + ",\"forwarded\":" + JsonKeys(forwarded)
                + ",\"tracked\":" + JsonKeys(tracked)
                + ",\"blocked_held\":" + JsonKeys(blockedHeld)
                + ",\"forwarded_node\":" + (forwardedNode == null ? "null" : "\"" + EscapeJson(forwardedNode) + "\"")
                + ",\"mismatch\":" + (mismatch ? "true" : "false")
                + ",\"stuck\":" + (stuck ? "true" : "false")
                + ",\"stuck_since\":" + stuckSince.ToString("F3", System.Globalization.CultureInfo.InvariantCulture)
                + ",\"changed\":" + (changed ? "true" : "false")
                + "}";
            if (changed && lastSignature.Length != 0)
            {
                Log("state " + signature + " " + json);
            }
            lastSignature = signature;
            lastReport = now;
            return json;
        }

        private static List<int> ReadKeys(int descriptor)
        {
            byte[] bits = new byte[KeyBitmapBytes];
            if (ioctl_buffer(descriptor, EviocGetKey, bits) < 0)
            {
                return null;
            }
            List<int> result = new List<int>();
            for (int code = 0; code <= KeyMaximum; code++)
            {
                if ((bits[code / 8] & (1 << (code % 8))) != 0)
                {
                    result.Add(code);
                }
            }
            return result;
        }

        private static bool SameKeys(List<int> left, List<int> right)
        {
            if (left == null || right == null || left.Count != right.Count)
            {
                return false;
            }
            for (int index = 0; index < left.Count; index++)
            {
                if (left[index] != right[index])
                {
                    return false;
                }
            }
            return true;
        }

        private static string JsonKeys(List<int> keys)
        {
            return keys == null ? "null" : "[" + string.Join(",", keys) + "]";
        }

        private static double Now()
        {
            return DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() / 1000.0;
        }

        private static void Log(string message)
        {
            Console.Error.WriteLine(
                DateTime.UtcNow.ToString("yyyy-MM-ddTHH:mm:ss.fffZ", System.Globalization.CultureInfo.InvariantCulture)
                + " " + message);
        }
    }
}
