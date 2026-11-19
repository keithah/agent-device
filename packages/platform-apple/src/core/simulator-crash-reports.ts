import crypto from 'node:crypto';
import path from 'node:path';
import {
  ensureHostDirectory,
  hostFileStat,
  readHostBinaryFile,
  readHostDirectory,
  writeHostBinaryFile,
} from '@agent-device/host-kit/host-file';
import { AppError } from '@agent-device/kernel/errors';
import { isRecord } from '@agent-device/kernel/record';
import { readJsonRecord, readString } from './debug-symbols/utils.ts';

/**
 * Research spike for crash discovery on the iOS Simulator (#1778). Nothing dispatches to this
 * module yet. Evidence: docs/evidence/ios-simulator-crash-attribution-2026-11-19.md.
 *
 * A simulator process crashes as a host process, so ReportCrash writes its `.ips` report to the
 * host user's `~/Library/Logs/DiagnosticReports`, next to reports from every other simulator and
 * from macOS itself. Two fields attribute a report:
 *
 * - the header line's `bundleID` names the app. Simulator daemons carry none.
 * - the body's `coalitionName` is `com.apple.CoreSimulator.SimDevice.<UDID>` for every process
 *   that launchd_sim started, including system apps whose `procPath` names no device.
 *
 * CONSERVATIVE: `coalitionName` is not documented by Apple, so a report without that exact value
 * is excluded and a format change yields an empty list, never an unattributed one. Revisit if
 * Apple documents a field that names the simulator.
 *
 * Only the default simulator device set is supported. `coalitionName` names no set, and a copied
 * set repeats its UDIDs. An installed app's `procPath` names its set, so its report from another
 * set is excluded. A system app's `procPath` names none, which leaves one known gap: while a copy
 * of the session's simulator runs from another set on the same host, a crash of the same system
 * app there is indistinguishable. A caller must refuse a session that is itself on a custom set.
 */

export const SIMULATOR_CRASH_REPORT_ARTIFACT_TYPE = 'crash-report';

const SIMULATOR_COALITION_PREFIX = 'com.apple.CoreSimulator.SimDevice.';
// ReportCrash replaces the user's home directory with `/Users/USER` in a report.
const DEFAULT_DEVICE_SET = '/Users/USER/Library/Developer/CoreSimulator/Devices';
const CRASH_REPORT_SOURCE = 'host-diagnostic-reports';
const DEFAULT_CRASH_LIST_LIMIT = 20;
const MAX_CRASH_LIST_LIMIT = 100;
// CONSERVATIVE: A larger file is skipped and only the newest candidates are examined, so one call
// does bounded work whatever the directory holds. Simulator reports seen so far are 13-77 KB.
// Revisit if a report can be attributed from a bounded read of its first line.
const MAX_CRASH_REPORT_BYTES = 1024 * 1024;
const MAX_EXAMINED_REPORTS = 500;
const INCIDENT_ID_RE = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/;
// For example `2026-11-19 14:22:18.6555 -0800`.
const REPORT_TIME_RE = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d+)?) ([+-]\d{2})(\d{2})$/;

export type SimulatorCrashReportScope = {
  /** The home directory of the host user who runs the simulator. */
  hostHome: string;
  simulatorUdid: string;
  bundleId: string;
};

export type SimulatorCrashReport = {
  /** The report's incident identifier. ReportCrash assigns it once and stores it in the report. */
  id: string;
  /** ISO 8601, UTC. Absent when the report's capture time is missing or not in the known format. */
  occurredAt?: string;
  app: string;
  process?: string;
  kind?: string;
  signal?: string;
  sizeBytes: number;
};

export type SimulatorCrashReportList = {
  crashes: SimulatorCrashReport[];
  /** True when more crashes match, or when older reports were left unexamined. */
  truncated: boolean;
  source: typeof CRASH_REPORT_SOURCE;
};

export type SimulatorCrashReportRetrieval = {
  crash: SimulatorCrashReport;
  artifact: {
    artifactType: typeof SIMULATOR_CRASH_REPORT_ARTIFACT_TYPE;
    path: string;
    sizeBytes: number;
    sha256: string;
  };
};

type ReportCandidate = { filePath: string; modifiedMs: number };

type ReportCandidates = { candidates: ReportCandidate[]; unexamined: boolean };

type AttributedReport = { crash: SimulatorCrashReport; contents: Buffer };

/**
 * Lists crashes of one app on one simulator, newest first. Returns metadata only.
 *
 * Attribution needs the report body, so each candidate file inside the time window is read until
 * the limit is reached. The body never leaves this function. The window and the order use the
 * time the report was written, which a listing learns without reading the file; `occurredAt` is
 * the capture time the report body records, which is earlier.
 */
export async function listSimulatorCrashReports(
  options: SimulatorCrashReportScope & { sinceMs?: number; limit?: number },
): Promise<SimulatorCrashReportList> {
  const limit = readListLimit(options.limit);
  const sinceMs = readSinceMs(options.sinceMs);
  const { candidates, unexamined } = await readReportCandidates(options.hostHome, sinceMs);
  const crashes: SimulatorCrashReport[] = [];
  for (const candidate of candidates) {
    const report = await readAttributedReport(candidate, options);
    if (!report) continue;
    if (crashes.length === limit) {
      return { crashes, truncated: true, source: CRASH_REPORT_SOURCE };
    }
    crashes.push(report.crash);
  }
  return { crashes, truncated: unexamined, source: CRASH_REPORT_SOURCE };
}

/**
 * Copies one crash report, unchanged, into `destinationDir`. The identifier resolves only inside
 * the same simulator and app scope as a listing, so a known incident identifier from another app
 * or simulator is reported as not found.
 */
export async function retrieveSimulatorCrashReport(
  options: SimulatorCrashReportScope & { id: string; destinationDir: string },
): Promise<SimulatorCrashReportRetrieval> {
  const id = options.id.toUpperCase();
  if (!INCIDENT_ID_RE.test(id)) {
    throw new AppError('INVALID_ARGS', 'The crash identifier is not an incident identifier.', {
      reason: 'crash_report_id_invalid',
      hint: 'Pass an id returned by the crash listing.',
    });
  }
  const { candidates, unexamined } = await readReportCandidates(options.hostHome, undefined);
  for (const candidate of candidates) {
    const report = await readAttributedReport(candidate, options);
    if (report?.crash.id !== id) continue;
    const artifactPath = path.join(options.destinationDir, `crash-${id}.ips`);
    await ensureHostDirectory(options.destinationDir);
    await writeHostBinaryFile(artifactPath, report.contents);
    return {
      crash: report.crash,
      artifact: {
        artifactType: SIMULATOR_CRASH_REPORT_ARTIFACT_TYPE,
        path: artifactPath,
        sizeBytes: report.contents.byteLength,
        sha256: crypto.createHash('sha256').update(report.contents).digest('hex'),
      },
    };
  }
  throw new AppError(
    'INVALID_ARGS',
    'No crash report with that identifier exists for this app on this simulator.',
    {
      reason: 'crash_report_not_found',
      source: CRASH_REPORT_SOURCE,
      hint: unexamined
        ? `Only the ${MAX_EXAMINED_REPORTS} newest host crash reports are examined, and this one may be older.`
        : 'List crashes again: macOS removes old reports, and a report can take several seconds to appear after a crash.',
    },
  );
}

function readListLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_CRASH_LIST_LIMIT;
  if (Number.isInteger(limit) && limit >= 1 && limit <= MAX_CRASH_LIST_LIMIT) return limit;
  throw new AppError(
    'INVALID_ARGS',
    `The crash list limit must be an integer from 1 to ${MAX_CRASH_LIST_LIMIT}.`,
    { reason: 'crash_list_limit_invalid' },
  );
}

function readSinceMs(sinceMs: number | undefined): number | undefined {
  if (sinceMs === undefined || Number.isFinite(sinceMs)) return sinceMs;
  throw new AppError('INVALID_ARGS', 'The crash list time window is not a valid time.', {
    reason: 'crash_list_since_invalid',
  });
}

async function readReportCandidates(
  hostHome: string,
  sinceMs: number | undefined,
): Promise<ReportCandidates> {
  const reportsDir = path.join(hostHome, 'Library', 'Logs', 'DiagnosticReports');
  const names = await readHostDirectory(reportsDir).catch((error: unknown) => {
    // A host that has never recorded a crash has no reports directory.
    if (isRecord(error) && error.code === 'ENOENT') return [];
    throw new AppError(
      'COMMAND_FAILED',
      'The host crash reports directory could not be read.',
      { reason: 'crash_reports_unreadable', source: CRASH_REPORT_SOURCE },
      error,
    );
  });
  const candidates: ReportCandidate[] = [];
  for (const name of names) {
    if (!name.endsWith('.ips')) continue;
    const filePath = path.join(reportsDir, name);
    // macOS prunes this directory, so a listed file can be gone before it is examined.
    const stat = await hostFileStat(filePath).catch(() => undefined);
    if (!stat?.isFile() || stat.size > MAX_CRASH_REPORT_BYTES) continue;
    if (sinceMs !== undefined && stat.mtimeMs < sinceMs) continue;
    candidates.push({ filePath, modifiedMs: stat.mtimeMs });
  }
  candidates.sort((a, b) => b.modifiedMs - a.modifiedMs);
  return {
    candidates: candidates.slice(0, MAX_EXAMINED_REPORTS),
    unexamined: candidates.length > MAX_EXAMINED_REPORTS,
  };
}

async function readAttributedReport(
  candidate: ReportCandidate,
  scope: SimulatorCrashReportScope,
): Promise<AttributedReport | undefined> {
  // A report that was pruned, or that grew past the bound since it was measured, is skipped.
  const contents = await readHostBinaryFile(candidate.filePath).catch(() => undefined);
  if (!contents || contents.byteLength > MAX_CRASH_REPORT_BYTES) return undefined;
  const text = contents.toString('utf8');
  const newlineIndex = text.indexOf('\n');
  if (newlineIndex === -1) return undefined;
  const header = readJsonRecord(text.slice(0, newlineIndex));
  if (!header || header.bundleID !== scope.bundleId) return undefined;
  const id = readString(header.incident_id)?.toUpperCase();
  if (!id || !INCIDENT_ID_RE.test(id)) return undefined;
  // A report ReportCrash is still writing has a body that does not parse yet; it is skipped.
  const body = readJsonRecord(text.slice(newlineIndex + 1));
  if (!body || !isFromSimulator(body, scope.simulatorUdid)) return undefined;
  const exception = isRecord(body.exception) ? body.exception : {};
  return {
    contents,
    crash: {
      id,
      occurredAt: readOccurredAt(body.captureTime),
      app: scope.bundleId,
      process: readString(body.procName),
      kind: readString(exception.type),
      signal: readString(exception.signal),
      sizeBytes: contents.byteLength,
    },
  };
}

function readOccurredAt(captureTime: unknown): string | undefined {
  const match = REPORT_TIME_RE.exec(readString(captureTime) ?? '');
  if (!match) return undefined;
  const time = new Date(`${match[1]}T${match[2]}${match[3]}:${match[4]}`).getTime();
  return Number.isNaN(time) ? undefined : new Date(time).toISOString();
}

function isFromSimulator(body: Record<string, unknown>, simulatorUdid: string): boolean {
  const udid = simulatorUdid.toUpperCase();
  const coalition = readString(body.coalitionName);
  if (!coalition?.startsWith(SIMULATOR_COALITION_PREFIX)) return false;
  if (coalition.slice(SIMULATOR_COALITION_PREFIX.length).toUpperCase() !== udid) return false;
  // An installed app runs from `<device set>/<UDID>/data/...`. When the path names a device
  // directory, that directory must be in the default set.
  const procPath = readString(body.procPath) ?? '';
  const deviceDirIndex = procPath.toUpperCase().indexOf(`/${udid}/DATA/`);
  return deviceDirIndex === -1 || procPath.slice(0, deviceDirIndex) === DEFAULT_DEVICE_SET;
}
