declare const __BONSAI_BUILD_ID__: string;
export const buildId = __BONSAI_BUILD_ID__;
let changed = false;

export function observeBuild(server: string | null): void {
  if (!server || server === buildId || buildId === 'development' || changed) return;
  changed = true;
  window.dispatchEvent(new Event('bonsai:updated'));
}

export function buildChanged(): boolean {
  return changed;
}

export function assertCurrentBuild(): void {
  if (changed) throw new Error('Bonsai was updated. Reload this tab before making changes.');
}
