import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import { mkdtempForTest } from '../../__tests__/tmp-dir.ts';
import { readAppleCrashArtifact } from '../debug-symbols/crash-artifact.ts';
import {
  listSimulatorCrashReports,
  retrieveSimulatorCrashReport,
  SIMULATOR_CRASH_REPORT_ARTIFACT_TYPE,
} from '../simulator-crash-reports.ts';
import {
  ipsReport,
  OTHER_BUNDLE_ID,
  OTHER_SIMULATOR_UDID,
  partialIpsReport,
  SESSION_BUNDLE_ID,
  SESSION_SIMULATOR_UDID,
} from './simulator-crash-reports.fixtures.ts';

const SESSION_INCIDENT = 'D03D78C8-D0AF-445E-B03B-F7E9618E88AB';
const OTHER_SIMULATOR_INCIDENT = '35C08C91-0000-4000-8000-000000000001';
const OTHER_APP_INCIDENT = '35C08C91-0000-4000-8000-000000000002';
const DAEMON_INCIDENT = '35C08C91-0000-4000-8000-000000000003';
const HOST_INCIDENT = '35C08C91-0000-4000-8000-000000000004';
const PARTIAL_INCIDENT = '35C08C91-0000-4000-8000-000000000005';

type WrittenReport = { name: string; text: string; modifiedAt?: Date };

/** Writes the reports into a new host home and returns that home. */
async function hostHomeWithReports(reports: WrittenReport[]): Promise<string> {
  const hostHome = await mkdtempForTest('agent-device-simulator-crashes-');
  const dir = path.join(hostHome, 'Library', 'Logs', 'DiagnosticReports');
  await fs.mkdir(dir, { recursive: true });
  for (const report of reports) {
    const filePath = path.join(dir, report.name);
    await fs.writeFile(filePath, report.text);
    if (report.modifiedAt) await fs.utimes(filePath, report.modifiedAt, report.modifiedAt);
  }
  return hostHome;
}

function sessionScope(hostHome: string) {
  return { hostHome, simulatorUdid: SESSION_SIMULATOR_UDID, bundleId: SESSION_BUNDLE_ID };
}

function sessionReport(incidentId: string, minute: number): WrittenReport {
  const stamp = String(minute).padStart(2, '0');
  return {
    name: `Demo-2026-11-19-14${stamp}00.ips`,
    text: ipsReport({
      incidentId,
      bundleId: SESSION_BUNDLE_ID,
      simulatorUdid: SESSION_SIMULATOR_UDID,
      captureTime: `2026-11-19 14:${stamp}:00.5000 -0800`,
    }),
    modifiedAt: new Date(`2026-11-19T14:${stamp}:00-08:00`),
  };
}

function incident(index: number): string {
  return `AAAAAAAA-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

test('lists only crashes of the session app on the session simulator', async () => {
  const expected = sessionReport(SESSION_INCIDENT, 22);
  const hostHome = await hostHomeWithReports([
    expected,
    {
      name: 'Demo-2026-11-19-142448.ips',
      text: ipsReport({
        incidentId: OTHER_SIMULATOR_INCIDENT,
        bundleId: SESSION_BUNDLE_ID,
        simulatorUdid: OTHER_SIMULATOR_UDID,
      }),
    },
    {
      name: 'Other-2026-11-19-142341.ips',
      text: ipsReport({
        incidentId: OTHER_APP_INCIDENT,
        bundleId: OTHER_BUNDLE_ID,
        simulatorUdid: SESSION_SIMULATOR_UDID,
        processName: 'Other',
      }),
    },
    {
      name: 'exampled-2026-11-19-142333.ips',
      text: ipsReport({
        incidentId: DAEMON_INCIDENT,
        simulatorUdid: SESSION_SIMULATOR_UDID,
        processName: 'exampled',
      }),
    },
    {
      name: 'Demo-2026-11-19-142500.ips',
      text: ipsReport({ incidentId: HOST_INCIDENT, bundleId: SESSION_BUNDLE_ID }),
    },
    {
      name: 'Demo-2026-11-19-142600.ips',
      text: partialIpsReport({
        incidentId: PARTIAL_INCIDENT,
        bundleId: SESSION_BUNDLE_ID,
        simulatorUdid: SESSION_SIMULATOR_UDID,
      }),
    },
    { name: 'Demo-2026-11-19-142700.ips', text: 'not a crash report' },
    { name: 'Demo-2026-11-19-142800.diag', text: 'spin report' },
  ]);

  const result = await listSimulatorCrashReports(sessionScope(hostHome));

  assert.deepEqual(result, {
    crashes: [
      {
        id: SESSION_INCIDENT,
        occurredAt: '2026-11-19T22:22:00.500Z',
        app: SESSION_BUNDLE_ID,
        process: 'Demo',
        kind: 'EXC_BREAKPOINT',
        signal: 'SIGTRAP',
        sizeBytes: Buffer.byteLength(expected.text),
      },
    ],
    truncated: false,
    source: 'host-diagnostic-reports',
  });
});

test('matches the simulator identifier without regard to letter case', async () => {
  const hostHome = await hostHomeWithReports([sessionReport(SESSION_INCIDENT, 22)]);

  const result = await listSimulatorCrashReports({
    ...sessionScope(hostHome),
    simulatorUdid: SESSION_SIMULATOR_UDID.toLowerCase(),
  });

  assert.deepEqual(
    result.crashes.map((crash) => crash.id),
    [SESSION_INCIDENT],
  );
});

test('returns the newest crashes first and reports truncation at the limit', async () => {
  const hostHome = await hostHomeWithReports([
    sessionReport(incident(1), 10),
    sessionReport(incident(3), 30),
    sessionReport(incident(2), 20),
  ]);

  const limited = await listSimulatorCrashReports({ ...sessionScope(hostHome), limit: 2 });
  assert.deepEqual(
    limited.crashes.map((crash) => crash.id),
    [incident(3), incident(2)],
  );
  assert.equal(limited.truncated, true);

  const all = await listSimulatorCrashReports({ ...sessionScope(hostHome), limit: 3 });
  assert.equal(all.crashes.length, 3);
  assert.equal(all.truncated, false);
});

test('does not count unrelated reports toward the limit', async () => {
  const unrelated = (minute: number): WrittenReport => ({
    name: `Other-2026-11-19-14${minute}00.ips`,
    text: ipsReport({
      incidentId: incident(minute),
      bundleId: OTHER_BUNDLE_ID,
      simulatorUdid: SESSION_SIMULATOR_UDID,
    }),
    modifiedAt: new Date(`2026-11-19T14:${minute}:00-08:00`),
  });
  const hostHome = await hostHomeWithReports([
    unrelated(40),
    unrelated(30),
    sessionReport(SESSION_INCIDENT, 22),
  ]);

  const result = await listSimulatorCrashReports({ ...sessionScope(hostHome), limit: 1 });

  assert.deepEqual(
    result.crashes.map((crash) => crash.id),
    [SESSION_INCIDENT],
  );
  assert.equal(result.truncated, false);
});

test('skips a report larger than the size bound', async () => {
  const oversized = sessionReport(incident(1), 30);
  const hostHome = await hostHomeWithReports([
    // Trailing whitespace keeps the report valid, so only its size excludes it.
    { ...oversized, text: oversized.text + ' '.repeat(1024 * 1024) },
    sessionReport(SESSION_INCIDENT, 22),
  ]);

  const result = await listSimulatorCrashReports(sessionScope(hostHome));

  assert.deepEqual(
    result.crashes.map((crash) => crash.id),
    [SESSION_INCIDENT],
  );
});

test('attributes an installed app only when it ran from the default simulator device set', async () => {
  const installedApp = (incidentId: string, deviceSet: string, minute: number): WrittenReport => ({
    ...sessionReport(incidentId, minute),
    text: ipsReport({
      incidentId,
      bundleId: SESSION_BUNDLE_ID,
      simulatorUdid: SESSION_SIMULATOR_UDID,
      procPath: `${deviceSet}/${SESSION_SIMULATOR_UDID}/data/Containers/Bundle/Application/A/Demo.app/Demo`,
    }),
  });
  const defaultSet = 'Library/Developer/CoreSimulator/Devices';
  const hostHome = await hostHomeWithReports([
    installedApp(incident(1), `/Users/USER/${defaultSet}`, 10),
    installedApp(incident(2), '/private/tmp/copied-device-set', 20),
    installedApp(incident(3), `/Volumes/cache/${defaultSet}`, 30),
  ]);

  const result = await listSimulatorCrashReports(sessionScope(hostHome));

  assert.deepEqual(
    result.crashes.map((crash) => crash.id),
    [incident(1)],
  );
});

test('excludes crashes written before the time window', async () => {
  const hostHome = await hostHomeWithReports([
    sessionReport(incident(1), 10),
    sessionReport(incident(2), 20),
  ]);

  const result = await listSimulatorCrashReports({
    ...sessionScope(hostHome),
    sinceMs: new Date('2026-11-19T14:15:00-08:00').getTime(),
  });

  assert.deepEqual(
    result.crashes.map((crash) => crash.id),
    [incident(2)],
  );
});

test('rejects a limit outside the supported range', async () => {
  const hostHome = await hostHomeWithReports([]);
  for (const limit of [0, -1, 1.5, 101]) {
    await assert.rejects(
      () => listSimulatorCrashReports({ ...sessionScope(hostHome), limit }),
      (error) => error instanceof AppError && error.code === 'INVALID_ARGS',
    );
  }
});

test('rejects a time window that is not a time', async () => {
  const hostHome = await hostHomeWithReports([]);
  await assert.rejects(
    () => listSimulatorCrashReports({ ...sessionScope(hostHome), sinceMs: Number.NaN }),
    (error) => error instanceof AppError && error.details?.reason === 'crash_list_since_invalid',
  );
});

test('reports a reports directory that cannot be read', async () => {
  const hostHome = await mkdtempForTest('agent-device-simulator-crashes-');
  await fs.mkdir(path.join(hostHome, 'Library', 'Logs'), { recursive: true });
  await fs.writeFile(
    path.join(hostHome, 'Library', 'Logs', 'DiagnosticReports'),
    'not a directory',
  );

  await assert.rejects(
    () => listSimulatorCrashReports(sessionScope(hostHome)),
    (error) =>
      error instanceof AppError &&
      error.code === 'COMMAND_FAILED' &&
      error.details?.reason === 'crash_reports_unreadable',
  );
});

test('lists nothing when the host has no diagnostic reports directory', async () => {
  const dir = await mkdtempForTest('agent-device-simulator-crashes-');

  const result = await listSimulatorCrashReports(sessionScope(dir));

  assert.deepEqual(result, { crashes: [], truncated: false, source: 'host-diagnostic-reports' });
});

test('retrieves one crash unchanged into the destination directory', async () => {
  const report = sessionReport(SESSION_INCIDENT, 22);
  const hostHome = await hostHomeWithReports([report, sessionReport(incident(9), 30)]);
  const destinationDir = path.join(await mkdtempForTest('agent-device-session-'), 'session');

  const result = await retrieveSimulatorCrashReport({
    ...sessionScope(hostHome),
    id: SESSION_INCIDENT.toLowerCase(),
    destinationDir,
  });

  const expectedPath = path.join(destinationDir, `crash-${SESSION_INCIDENT}.ips`);
  assert.equal(result.crash.id, SESSION_INCIDENT);
  assert.deepEqual(result.artifact, {
    artifactType: SIMULATOR_CRASH_REPORT_ARTIFACT_TYPE,
    path: expectedPath,
    sizeBytes: Buffer.byteLength(report.text),
    sha256: crypto.createHash('sha256').update(report.text).digest('hex'),
  });
  assert.deepEqual(await fs.readdir(destinationDir), [`crash-${SESSION_INCIDENT}.ips`]);
  const retrieved = await fs.readFile(expectedPath, 'utf8');
  assert.equal(retrieved, report.text);
  // The retrieved file is what `debug symbols --artifact` reads.
  assert.equal(readAppleCrashArtifact(retrieved)?.format, 'ips');
});

test('does not retrieve a crash from another app or simulator', async () => {
  const hostHome = await hostHomeWithReports([
    {
      name: 'Demo-2026-11-19-142448.ips',
      text: ipsReport({
        incidentId: OTHER_SIMULATOR_INCIDENT,
        bundleId: SESSION_BUNDLE_ID,
        simulatorUdid: OTHER_SIMULATOR_UDID,
      }),
    },
    {
      name: 'Other-2026-11-19-142341.ips',
      text: ipsReport({
        incidentId: OTHER_APP_INCIDENT,
        bundleId: OTHER_BUNDLE_ID,
        simulatorUdid: SESSION_SIMULATOR_UDID,
      }),
    },
  ]);
  const destinationDir = await mkdtempForTest('agent-device-session-');

  for (const id of [OTHER_SIMULATOR_INCIDENT, OTHER_APP_INCIDENT]) {
    await assert.rejects(
      () => retrieveSimulatorCrashReport({ ...sessionScope(hostHome), id, destinationDir }),
      (error) =>
        error instanceof AppError &&
        error.code === 'INVALID_ARGS' &&
        error.details?.reason === 'crash_report_not_found',
    );
  }
  assert.deepEqual(await fs.readdir(destinationDir), []);
});

test('rejects a crash identifier that is not an incident identifier', async () => {
  const hostHome = await hostHomeWithReports([sessionReport(SESSION_INCIDENT, 22)]);
  const destinationDir = await mkdtempForTest('agent-device-session-');

  await assert.rejects(
    () =>
      retrieveSimulatorCrashReport({
        ...sessionScope(hostHome),
        id: '../Demo-2026-11-19-142200',
        destinationDir,
      }),
    (error) =>
      error instanceof AppError &&
      error.code === 'INVALID_ARGS' &&
      error.details?.reason === 'crash_report_id_invalid',
  );
});
