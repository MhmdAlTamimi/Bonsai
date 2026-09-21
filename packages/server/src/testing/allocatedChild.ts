import { allocateNodeWorktree, createChildNode } from '../projects.js';
/** Git-focused fixtures explicitly request a real checkout; production creation remains lazy. */
export async function createAllocatedChild(
  ...args: Parameters<typeof createChildNode>
): ReturnType<typeof createChildNode> {
  const created = await createChildNode(...args);
  const seeded = await allocateNodeWorktree(args[0], args[0].getNode(created.nodeId)!);
  return { ...created, seeded };
}
