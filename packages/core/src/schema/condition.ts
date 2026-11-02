// 条件の式の検査と評価。値が決まっていない時は「分からない」を返す三値の論理。
import type { ConditionNode, Unknown } from './source';

export type Truth = true | false | 'unknown';

/** 決まった未定の値（未定の値の ID → 値）。 */
export type Assignment = ReadonlyMap<string, string>;

export interface ConditionIssue {
  nodeId: string;
  problem:
    | 'duplicateId'
    | 'missingChild'
    | 'cycle'
    | 'undeclaredUnknown'
    | 'undeclaredValue'
    | 'tooLarge';
  detail?: string;
}

/** 一つのお知らせの条件の節点の上限。実際のお知らせは数個で、これを超える読み取りは使わない。 */
export const MAX_CONDITION_NODES = 64;

/** 参照・循環・宣言の無い未定の値と値・大きすぎる式を見つける。空なら使ってよい。 */
export function validateConditions(
  nodes: readonly ConditionNode[],
  unknowns: readonly Unknown[],
): ConditionIssue[] {
  if (nodes.length > MAX_CONDITION_NODES) {
    return nodes.map((node) => ({
      nodeId: node.id,
      problem: 'tooLarge',
      detail: `${nodes.length} > ${MAX_CONDITION_NODES}`,
    }));
  }
  const issues: ConditionIssue[] = [];
  const byId = new Map<string, ConditionNode>();
  for (const node of nodes) {
    if (byId.has(node.id)) issues.push({ nodeId: node.id, problem: 'duplicateId' });
    byId.set(node.id, node);
  }
  const declared = new Map(unknowns.map((u) => [u.id, new Set(u.values)]));
  for (const node of nodes) {
    if (node.kind === 'eq') {
      const values = declared.get(node.unknownId);
      if (!values) {
        issues.push({ nodeId: node.id, problem: 'undeclaredUnknown', detail: node.unknownId });
      } else if (!values.has(node.value)) {
        issues.push({ nodeId: node.id, problem: 'undeclaredValue', detail: node.value });
      }
    }
    for (const child of childrenOf(node)) {
      if (!byId.has(child))
        issues.push({ nodeId: node.id, problem: 'missingChild', detail: child });
    }
  }
  // 循環：深さ優先で、たどっている途中の節点に戻ったら循環。
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (id: string): void => {
    const mark = state.get(id);
    if (mark === 'done') return;
    if (mark === 'visiting') {
      issues.push({ nodeId: id, problem: 'cycle' });
      return;
    }
    state.set(id, 'visiting');
    const node = byId.get(id);
    if (node) for (const child of childrenOf(node)) visit(child);
    state.set(id, 'done');
  };
  for (const node of nodes) visit(node.id);
  return issues;
}

function childrenOf(node: ConditionNode): string[] {
  switch (node.kind) {
    case 'and':
    case 'or':
      return node.childIds;
    case 'not':
      return [node.childId];
    case 'eq':
      return [];
  }
}

/** 条件を評価する。検査（validateConditions）を通った節点だけを渡す。共有された子は一度だけ評価する。 */
export function evaluateCondition(
  nodeId: string,
  nodes: readonly ConditionNode[],
  assignment: Assignment,
): Truth {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const memo = new Map<string, Truth>();
  const evaluate = (id: string): Truth => {
    const known = memo.get(id);
    if (known !== undefined) return known;
    const node = byId.get(id);
    if (!node) throw new Error(`条件の節点が無い：${id}`);
    const value = evaluateNode(node, evaluate, assignment);
    memo.set(id, value);
    return value;
  };
  return evaluate(nodeId);
}

function evaluateNode(
  node: ConditionNode,
  evaluate: (id: string) => Truth,
  assignment: Assignment,
): Truth {
  switch (node.kind) {
    case 'eq': {
      const value = assignment.get(node.unknownId);
      if (value === undefined) return 'unknown';
      return value === node.value;
    }
    case 'not': {
      const inner = evaluate(node.childId);
      return inner === 'unknown' ? 'unknown' : !inner;
    }
    case 'and': {
      let result: Truth = true;
      for (const child of node.childIds) {
        const value = evaluate(child);
        if (value === false) return false;
        if (value === 'unknown') result = 'unknown';
      }
      return result;
    }
    case 'or': {
      let result: Truth = false;
      for (const child of node.childIds) {
        const value = evaluate(child);
        if (value === true) return true;
        if (value === 'unknown') result = 'unknown';
      }
      return result;
    }
  }
}
