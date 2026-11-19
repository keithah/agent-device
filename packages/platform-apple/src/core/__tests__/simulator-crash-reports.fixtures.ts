export const SESSION_SIMULATOR_UDID = '045617CD-D619-4BE0-9EBD-FAE51D5A59B9';
export const OTHER_SIMULATOR_UDID = '617709D3-8D1B-43B7-A72A-E4AC7841EF2A';
export const SESSION_BUNDLE_ID = 'com.example.Demo';
export const OTHER_BUNDLE_ID = 'com.example.Other';

export type IpsReportFixture = {
  incidentId: string;
  /** Omit for a daemon report, which carries no bundle identifier. */
  bundleId?: string;
  /** Omit for a report from a process that did not run inside a simulator. */
  simulatorUdid?: string;
  processName?: string;
  /** When ReportCrash captured the crash. The header timestamp, when the report was written, is fixed. */
  captureTime?: string;
  /** Defaults to a system app path, which names no simulator device directory. */
  procPath?: string;
};

/**
 * A simulator `.ips` report as ReportCrash writes it on the host: one JSON header line, then a
 * JSON body. Field names and shapes are taken from reports captured on macOS 26.6 with an iOS 27.2
 * simulator; values are synthetic.
 */
export function ipsReport(fixture: IpsReportFixture): string {
  const processName = fixture.processName ?? 'Demo';
  const header = {
    app_name: processName,
    timestamp: '2026-11-19 14:22:24.00 -0800',
    app_version: '1.0',
    build_version: '1',
    platform: fixture.simulatorUdid ? 7 : 1,
    ...(fixture.bundleId ? { bundleID: fixture.bundleId } : {}),
    bug_type: '309',
    name: processName,
    incident_id: fixture.incidentId,
  };
  const body = {
    procName: processName,
    captureTime: fixture.captureTime ?? '2026-11-19 14:22:18.6555 -0800',
    procPath: fixture.procPath ?? `/private/var/run/example/${processName}`,
    parentProc: fixture.simulatorUdid ? 'launchd_sim' : 'launchd',
    coalitionName: fixture.simulatorUdid
      ? `com.apple.CoreSimulator.SimDevice.${fixture.simulatorUdid}`
      : `com.example.${processName}`,
    exception: { type: 'EXC_BREAKPOINT', signal: 'SIGTRAP', codes: '0x1, 0x1c47c6c48' },
    termination: { namespace: 'SIGNAL', indicator: 'Trace/BPT trap: 5' },
    faultingThread: 0,
    threads: [{ triggered: true, frames: [{ imageOffset: 4096, imageIndex: 0 }] }],
    usedImages: [
      {
        source: 'P',
        arch: 'arm64',
        base: 4294967296,
        size: 65536,
        uuid: 'abcdefab-cdef-abcd-efab-cdefabcdefab',
        path: `/private/var/run/example/${processName}`,
        name: processName,
      },
    ],
  };
  return `${JSON.stringify(header)}\n${JSON.stringify(body, null, 2)}\n`;
}

/** A report ReportCrash has not finished writing: a complete header, a truncated body. */
export function partialIpsReport(fixture: IpsReportFixture): string {
  const complete = ipsReport(fixture);
  return complete.slice(0, complete.indexOf('\n') + 40);
}
