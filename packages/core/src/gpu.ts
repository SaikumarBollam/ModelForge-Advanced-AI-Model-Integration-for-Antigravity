import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { GpuInfo } from '@modelforge/shared-types';

const execFileAsync = promisify(execFile);

/**
 * NVIDIA GPU detection via nvidia-smi (when present).
 * Returns an empty list — never throws — on machines without NVIDIA tooling,
 * so the dashboard can render an honest "no GPU detected" state.
 */

export async function detectGpus(): Promise<GpuInfo[]> {
  try {
    const { stdout } = await execFileAsync('nvidia-smi', [
      '--query-gpu=index,name,memory.total,memory.used,utilization.gpu,driver_version',
      '--format=csv,noheader,nounits',
    ], { timeout: 5000 });
    return stdout.trim().split('\n').filter(Boolean).map((line) => {
      const [index, name, total, used, util, driver] = line.split(',').map((s) => s.trim());
      return {
        index: Number(index ?? 0),
        name: name ?? 'Unknown NVIDIA GPU',
        memoryTotalMb: Number(total),
        memoryUsedMb: Number(used),
        utilizationPct: Number(util),
        driverVersion: driver,
      };
    });
  } catch {
    return [];
  }
}

export async function detectCudaVersion(): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('nvidia-smi', [], { timeout: 5000 });
    const match = stdout.match(/CUDA Version:\s*([\d.]+)/);
    return match?.[1];
  } catch {
    return undefined;
  }
}
