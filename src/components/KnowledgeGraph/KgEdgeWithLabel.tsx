import { useState } from "react";
import { BaseEdge, EdgeLabelRenderer, getBezierPath, type EdgeProps } from "@xyflow/react";
import { EDGE_TYPES, EDGE_TYPE_STYLES } from "./constants";
import { useUpdateKgEdge } from "@/hooks/useKgQueries";

export interface KgEdgeData {
  type: string;
  label: string;
  /** 聚焦高亮状态：related=与选中节点直接相连（主色流动）；dimmed=有选中节点但不相连（淡出） */
  highlight?: "related" | "dimmed";
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
  // 虚拟边（parent_id 关系 / 笔记子节点关系）id 以 "ve:" 开头，不可编辑
  const isVirtual = id.startsWith("ve:");
  const numericId = Number(id.replace(/^ve:/, ""));

  const [menuOpen, setMenuOpen] = useState(false);
  const updateEdge = useUpdateKgEdge();

  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });

  const handleTypeChange = (type: string) => {
    updateEdge.mutate({ id: numericId, edge_type: type, label: edgeData.label });
    setMenuOpen(false);
  };

  // 类型标签文本（仅用于显示，不可编辑的虚拟边无文本时不显示按钮）
  const labelText = edgeData.type;

  // 聚焦高亮状态
  const isRelated = edgeData.highlight === "related";
  const isDimmed = edgeData.highlight === "dimmed";
  // 关联边用主题主色
  const strokeColor = isRelated ? "var(--primary)" : style.stroke;

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        className="kg-edge-anim"
        style={{
          stroke: strokeColor,
          strokeWidth: isRelated || selected ? 2.5 : 1.5,
          opacity: isDimmed ? 0.15 : 1,
          strokeDasharray: style.dashed ? "6 4" : undefined,
        }}
      />
      {selected && (
        <BaseEdge
          id={`${id}-flow`}
          path={edgePath}
          style={{ stroke: strokeColor, strokeWidth: 2.5, opacity: 0.7 }}
          className="kg-edge-flow"
        />
      )}
      <EdgeLabelRenderer>
        <div
          style={{
            position: "absolute",
            transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            pointerEvents: "all",
            opacity: isDimmed ? 0.15 : 1,
            transition: "opacity 200ms ease",
          }}
        >
          {menuOpen && !isVirtual ? (
            <>
              {/* 透明 backdrop：点击空白处关闭菜单 */}
              <div className="fixed inset-0 z-10" onClick={() => setMenuOpen(false)} />
              <div className="relative z-20 rounded-md border border-border bg-background p-1 shadow-lg">
                <select
                  value={edgeData.type}
                  onChange={(e) => handleTypeChange(e.target.value)}
                  autoFocus
                  className="rounded border border-border bg-transparent px-1 py-0.5 text-[11px] outline-none focus:border-primary"
                >
                  {EDGE_TYPES.map((t) => (
                    <option key={t.value} value={t.value}>
                      {t.label}
                    </option>
                  ))}
                </select>
              </div>
            </>
          ) : isVirtual ? null : (
            <button
              onClick={() => setMenuOpen(true)}
              className="rounded bg-background px-1.5 py-0.5 text-[10px] text-muted-foreground border border-border shadow-sm hover:bg-accent cursor-pointer"
              title="点击修改类型"
            >
              {labelText}
            </button>
          )}
        </div>
      </EdgeLabelRenderer>
    </>
  );
}
