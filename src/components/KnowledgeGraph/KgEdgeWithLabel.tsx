import { BaseEdge, EdgeLabelRenderer, getBezierPath, type EdgeProps } from "@xyflow/react";
import { EDGE_TYPE_STYLES } from "./constants";

export interface KgEdgeData {
  type: string;
  label: string;
  [key: string]: unknown;
}

export default function KgEdgeWithLabel({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
  selected,
}: EdgeProps) {
  const edgeData = (data ?? {}) as KgEdgeData;
  const style = EDGE_TYPE_STYLES[edgeData.type] ?? EDGE_TYPE_STYLES.related;
  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        style={{
          stroke: style.stroke,
          strokeWidth: selected ? 2.5 : 1.5,
          strokeDasharray: style.dashed ? "6 4" : undefined,
        }}
      />
      {(edgeData.label || edgeData.type) && (
        <EdgeLabelRenderer>
          <div
            style={{
              position: "absolute",
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
              pointerEvents: "all",
            }}
            className="rounded bg-background px-1.5 py-0.5 text-[10px] text-muted-foreground border border-border shadow-sm"
          >
            {edgeData.label || edgeData.type}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}
