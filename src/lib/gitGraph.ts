import type { GitCommit } from "../types";

export type GraphEdge = { from: number; to: number };
export type GraphRow = {
  commit: GitCommit;
  column: number;
  start: (string | null)[];
  end: (string | null)[];
  edges: GraphEdge[];
};
export type GraphLayout = { rows: GraphRow[]; lanes: number };

export const GRAPH_COLORS = [
  "#6cb6ff", "#9bd6bd", "#c792ea", "#dfc38c", "#e99595", "#7ec8a9",
  "#f2a7d8", "#8fd3f4", "#b9e88f", "#f0b37e", "#a9b8f5", "#d6a6f2",
];

export const laneColor = (lane: number) => GRAPH_COLORS[lane % GRAPH_COLORS.length];

/** Assign a stable lane to every commit, following parents into the rows below. */
export function layoutCommitGraph(commits: GitCommit[]): GraphLayout {
  const lanes: (string | null)[] = [];
  const rows: GraphRow[] = [];
  let width = 1;
  for (const commit of commits) {
    const start = [...lanes];
    let column = lanes.indexOf(commit.hash);
    if (column === -1) {
      column = lanes.indexOf(null);
      if (column === -1) { column = lanes.length; lanes.push(commit.hash); }
      else lanes[column] = commit.hash;
    } else {
      for (let index = column + 1; index < lanes.length; index++) {
        if (lanes[index] === commit.hash) lanes[index] = null;
      }
    }
    lanes[column] = null;
    const edges: GraphEdge[] = [];
    for (const parent of commit.parents) {
      let target = lanes.indexOf(parent);
      if (target === -1) {
        if (lanes[column] === null) target = column;
        else {
          target = lanes.indexOf(null);
          if (target === -1) { target = lanes.length; lanes.push(parent); }
        }
        lanes[target] = parent;
      }
      edges.push({ from: column, to: target });
    }
    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();
    const end = [...lanes];
    width = Math.max(width, start.length, end.length, column + 1, ...edges.map((edge) => edge.to + 1));
    rows.push({ commit, column, start, end, edges });
  }
  return { rows, lanes: width };
}
