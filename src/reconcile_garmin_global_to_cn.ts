import { getGaminGlobalClient } from './utils/garmin_global';
import { getGaminCNClient } from './utils/garmin_cn';
import { downloadGarminActivity } from './utils/garmin_common';

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const dryRun = process.env.RECONCILE_DRY_RUN !== 'false';
const limit = Number(process.env.RECONCILE_LIMIT || '50');

async function inventory(client: any): Promise<any[]> {
    const result: any[] = [];
    const seen = new Set<number>();
    for (let offset = 0; offset < 100000; offset += 100) {
        const page = await client.getActivities(offset, 100);
        if (!Array.isArray(page)) throw new Error('Invalid activity inventory response');
        if (!page.length) return result;
        let added = 0;
        for (const activity of page) {
            if (!activity.activityId) throw new Error('Activity inventory missing identifier');
            if (!seen.has(activity.activityId)) {
                seen.add(activity.activityId);
                result.push(activity);
                added++;
            }
        }
        if (!added) throw new Error('Activity pagination did not advance');
        // Continue until an empty page, even if the server caps the page size.
        offset -= 100 - page.length;
    }
    throw new Error('Activity inventory exceeded pagination safety limit');
}

function timestamp(activity: any): number {
    const value = activity.startTimeGMT;
    if (!value) throw new Error('Cannot safely reconcile activity without UTC start time');
    const normalized = value.replace(' ', 'T');
    const millis = Date.parse(/(?:Z|[+-]\d{2}:?\d{2})$/.test(normalized) ? normalized : normalized + 'Z');
    if (!Number.isFinite(millis)) throw new Error('Invalid UTC activity timestamp');
    return millis;
}

function sameIdentity(source: any, target: any): boolean {
    if (Math.abs(timestamp(source) - timestamp(target)) > 2000) return false;
    if (!Number.isFinite(Number(source.duration)) || !Number.isFinite(Number(target.duration))) return false;
    if (Math.abs(Number(source.duration) - Number(target.duration)) > 2) return false;
    return source.activityType?.typeKey === target.activityType?.typeKey;
}

function sameActivity(source: any, target: any): boolean {
    if (!sameIdentity(source, target)) return false;
    const sourceDistance = Number(source.distance || 0);
    const targetDistance = Number(target.distance || 0);
    return Math.abs(sourceDistance - targetDistance) <= Math.max(10, sourceDistance * 0.001);
}

function missingActivities(source: any[], target: any[], matcher = sameIdentity): any[] {
    const used = new Set<number>();
    return source.filter(activity => {
        const index = target.findIndex((other, i) => !used.has(i) && matcher(activity, other));
        if (index < 0) return true;
        used.add(index);
        return false;
    });
}

async function main() {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error('Batch limit must be 1 to 500');
    const globalClient = await getGaminGlobalClient();
    const cnClient = await getGaminCNClient();
    if (!globalClient || !cnClient) throw new Error('Garmin authentication failed');
    for (const client of [globalClient, cnClient]) {
        client.client.client.defaults.timeout = 60000;
        client.client.client.defaults.timeoutErrorMessage = 'Garmin request timed out after 60 seconds';
    }
    const repairPairs: number[][] = JSON.parse(process.env.RECONCILE_REPAIR_PAIRS || '[]');
    if (!dryRun) for (const [sourceId, targetId] of repairPairs) {
        const original = await globalClient.getActivity({activityId:sourceId});
        const existing = await cnClient.getActivity({activityId:targetId});
        const a = original.summaryDTO;
        const b = existing.summaryDTO;
        if (original.activityTypeDTO?.typeKey !== 'treadmill_running' ||
            existing.activityTypeDTO?.typeKey !== 'treadmill_running' ||
            Math.abs(timestamp(a) - timestamp(b)) > 60000 ||
            Math.abs(a.duration - b.duration) > 2 || !(a.distance > 0)) {
            throw new Error('Historical repair pair did not pass identity checks');
        }
        await cnClient.client.put(cnClient.url.ACTIVITY + targetId, {activityId:targetId,
            summaryDTO:{distance:a.distance,duration:a.duration,startTimeGMT:a.startTimeGMT,startTimeLocal:a.startTimeLocal}});
        const verified = await cnClient.getActivity({activityId:targetId});
        if (Math.abs(verified.summaryDTO.distance-a.distance)>0.01 ||
            timestamp(verified.summaryDTO)!==timestamp(a)) throw new Error('Historical metadata repair did not verify');
        console.log('Verified historical treadmill metadata repair');
    }
    const source = await inventory(globalClient);
    let target = await inventory(cnClient);
    // Validate all timestamps before any uploads.
    source.forEach(timestamp);
    target.forEach(timestamp);
    const missing = missingActivities(source, target).sort((a,b) => timestamp(a) - timestamp(b));
    const differences = source.flatMap(activity => {
        const other = target.find(item => sameIdentity(activity, item));
        return other && !sameActivity(activity, other) ? [{sourceId:activity.activityId,
            targetId:other.activityId, sourceDistance:activity.distance, targetDistance:other.distance}] : [];
    });
    console.log(JSON.stringify({phase:'inventory', source:source.length, target:target.length,
        matched:source.length-missing.length, missing:missing.length, metadataDifferences:differences, dryRun}));
    if (dryRun || !missing.length) return;
    const batch = missing.slice(0, limit);
    for (let i=0; i<batch.length; i++) {
        let accepted = false;
        for (let attempt=1; attempt<=3; attempt++) {
            try {
                const path = await downloadGarminActivity(batch[i].activityId, globalClient);
                const response = await cnClient.uploadActivity(path);
                const result = response && response.detailedImportResult;
                if (!result || (result.failures && result.failures.length)) throw new Error('Import rejected');
                accepted = true;
                break;
            } catch (error) {
                const reason = error instanceof Error ? error.message.match(/HTTP Error \(\d+\)|timeout|ECONNRESET|ENOENT|Import rejected/i)?.[0] : null;
                console.log('Upload attempt ' + attempt + ' failed for batch item ' + (i+1) + ': ' + (reason || 'request failure'));
                if (attempt < 3) await pause(5000 * attempt);
            }
        }
        console.log((accepted ? 'Accepted FIT upload ' : 'Unverified FIT upload ') + (i+1) + '/' + batch.length);
        await pause(2000);
    }
    for (let attempt=0; attempt<6; attempt++) {
        await pause(10000);
        target = await inventory(cnClient);
        const batchMissing = missingActivities(batch, target, sameActivity);
        if (!batchMissing.length) {
            const remaining = missingActivities(source, target).length;
            console.log(JSON.stringify({phase:'verified', source:source.length, target:target.length,
                verifiedUploads:batch.length, remaining}));
            if (remaining) console.log('More batches are required; rerun with dry_run=false.');
            return;
        }
        console.log('Waiting for Garmin processing: ' + batchMissing.length + ' batch activities unverified');
    }
    throw new Error('Uploaded activities could not all be verified by UTC start time, duration and distance');
}

if (require.main === module) {
    main().catch(error => {
        console.error(error instanceof Error ? error.message : 'Reconciliation failed');
        process.exitCode = 1;
    });
}

export { timestamp, sameActivity, missingActivities, inventory, main };

