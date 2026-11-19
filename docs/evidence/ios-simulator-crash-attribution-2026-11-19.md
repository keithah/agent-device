# iOS Simulator crash report attribution, 2026-11-19

Research spike for #1778. The question: can a crash report be attributed to one
simulator and one app reliably enough to exclude crashes from other apps and other
simulators? The answer on this host is yes for the default simulator device set,
with the limits listed below.

## Host and method

- macOS 26.6.2 (25G83), Xcode 27.2, iOS 27.2 simulator runtime (24B8117).
- Two simulators in the default device set: iPhone 17
  (`045617CD-D619-4BE0-9EBD-FAE51D5A59B9`) and iPhone 17e
  (`617709D3-8D1B-43B7-A72A-E4AC7841EF2A`).
- A throwaway UIKit app, bundle identifier `dev.spike.crashprobe`, built with `swiftc`
  and signed ad hoc. It is not in the repository. It crashed at launch with
  `EXC_BREAKPOINT` (`SIGTRAP`).
- Settings (`com.apple.Preferences`) received `SIGSEGV`, and later `SIGABRT`, from the host.
- The simulator daemon `intelligencetasksd` crashed 13 times on its own during the run.

Commands, with `<udid>` one of the two simulators:

```sh
xcrun simctl boot <udid> && xcrun simctl bootstatus <udid>
xcrun simctl install <udid> CrashProbe.app
xcrun simctl launch --terminate-running-process <udid> dev.spike.crashprobe
xcrun simctl launch --terminate-running-process <udid> com.apple.Preferences
kill -SEGV <pid printed by the launch>
kill -ABRT <pid printed by the launch>
find ~/Library/Logs/DiagnosticReports -newer <marker file> -type f
```

Each report was read as a JSON header line followed by a JSON body.

## Where reports go

A simulator process crashes as a host process. ReportCrash writes one `.ips` file per
crash to the host user's `~/Library/Logs/DiagnosticReports`, beside reports from every
other simulator and from macOS. The simulator's own data directory received none.

## Fields that attribute a report

| Need | Field | Location |
| --- | --- | --- |
| App | `bundleID` | header line |
| Simulator | `coalitionName`, `com.apple.CoreSimulator.SimDevice.<UDID>` | body |
| Stable handle | `incident_id` | header line |
| Crash time | `captureTime` | body |
| Time the report was written | `timestamp`, equal to the file's modification time | header line |
| Device set, installed apps only | `procPath` | body |

Observed on this host:

- All 105 reports whose parent process is `launchd_sim` carry the simulator UDID in
  `coalitionName`. No simulator report lacks it.
- The probe app's reports name the simulator each crash ran on. The same app on the
  second simulator produced a report with the second UDID.
- The Settings report carries the UDID and its own bundle identifier.
- The daemon reports carry the UDID and no `bundleID`.
- macOS process reports carry no simulator coalition.
- `procPath` of an installed app is
  `/Users/USER/Library/Developer/CoreSimulator/Devices/<UDID>/data/...`. ReportCrash
  replaces the home directory with `/Users/USER`. `procPath` of a system app names no
  device directory.

`packages/platform-apple/src/core/simulator-crash-reports.ts`, as added with this
document, applies these rules. `listSimulatorCrashReports` run against the reports above
returned, as incident prefix, `occurredAt` and signal:

| Simulator | App | Crashes listed |
| --- | --- | --- |
| iPhone 17 | `dev.spike.crashprobe` | `A2C66B15` 22:23:35.603Z `SIGTRAP`; `D03D78C8` 22:22:18.655Z `SIGTRAP` |
| iPhone 17e | `dev.spike.crashprobe` | `35C08C91` 22:24:46.612Z `SIGTRAP` |
| iPhone 17 | `com.apple.Preferences` | `9E1E85FA` 22:23:39.210Z `SIGABRT`; `64D3C578` 20:54:53.644Z `SIGSEGV` |
| iPhone 17e | `com.apple.Preferences` | none |

`retrieveSimulatorCrashReport` copied `A2C66B15` and `35C08C91`: 21,532 and 18,989
bytes, equal to the source files.

## Limits

- `coalitionName` is not documented by Apple. The module excludes a report without
  the exact value, so a format change gives an empty list.
- A listing must read report bodies. The simulator UDID is not in the header line or
  the file name.
- One of four deliberate crashes produced no report: the first crash on the second
  simulator, directly after its first boot. The cause is unknown. An empty list does
  not prove that no crash occurred.
- A report was written 1 to 6 seconds after `captureTime` for the probe app, and 48
  seconds after it for one Settings crash.
- macOS removes old reports from this directory.
- Custom device sets are not covered. `coalitionName` names no set, and a copied set
  repeats its UDIDs. For a system app, a crash in a copy of the session's simulator
  cannot be told apart.
- Stability of `incident_id` across a simulator reboot was not tested. The identifier
  is stored in the report file.

## Not done

- No command dispatches to the module, and nothing writes a report into the session
  artifact store. `retrieveSimulatorCrashReport` copies one report into a directory
  that its caller names.
- No crashing fixture app or simulator lane was added.
- Physical devices, Android, macOS and providers were not examined.
