import type { AgentModel } from '@bonsai/shared';

/**
 * The models offered when Claude Code has not said which it has -- offline, or
 * not signed in yet -- and the floor under what it reports: an older Claude
 * Code only knows the models that existed when it was released, and a model
 * missing from its list should not vanish from the picker.
 */
export const BUILT_IN_MODELS: readonly AgentModel[] = [
  { id: 'claude-opus-5-5', label: 'Opus 5.5', description: null, efforts: null },
  { id: 'claude-opus-5', label: 'Opus 5', description: null, efforts: null },
  { id: 'claude-sonnet-5', label: 'Sonnet 5', description: null, efforts: null },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5', description: null, efforts: null },
];

const FAMILIES = ['fable', 'mythos', 'opus', 'sonnet', 'haiku'];

/**
 * What the picker lists: what Claude Code reported for this credential, plus
 * the built-in models it did not mention, most capable family first and the
 * newest of each first. A reported entry wins over a built-in one with the
 * same id, since it carries the model's own description and effort levels.
 */
export function pickerModels(reported: readonly AgentModel[] | undefined): AgentModel[] {
  const byId = new Map<string, AgentModel>();
  for (const model of reported ?? []) byId.set(model.id, model);
  for (const model of BUILT_IN_MODELS) if (!byId.has(model.id)) byId.set(model.id, model);
  return [...byId.values()]
    .map((model, index) => ({ model, index, rank: rankOf(model.id) }))
    .sort(
      (a, b) =>
        a.rank.family - b.rank.family ||
        b.rank.major - a.rank.major ||
        b.rank.minor - a.rank.minor ||
        a.index - b.index,
    )
    .map(({ model }) => model);
}

/** `claude-opus-5-5` → opus, 5, 5. An id it cannot read sorts after the families it knows. */
function rankOf(id: string): { family: number; major: number; minor: number } {
  const match = /^claude-([a-z]+)-(\d+)(?:-(\d+))?/.exec(id);
  const family = match === null ? -1 : FAMILIES.indexOf(match[1]!);
  return {
    family: family === -1 ? FAMILIES.length : family,
    major: Number(match?.[2] ?? 0),
    minor: Number(match?.[3] ?? 0),
  };
}
