"use client";

import * as React from "react";
import { Activity, Check, ChevronDown, ChevronUp, Loader2, Pencil, RotateCcw, Trash2, X } from "lucide-react";
import { Badge } from "@subboost/ui/components/ui/badge";
import { IconButton } from "@subboost/ui/components/ui/icon-button";
import { Input } from "@subboost/ui/components/ui/input";
import { ProtocolBadge } from "@subboost/ui/components/ui/protocol-badge";
import { toast } from "@subboost/ui/components/ui/toaster";
import { formatNodeNameFromTemplate } from "@subboost/core/node-name-template";
import { getCfPreferredMark } from "@subboost/core/subscription/cf-preferred";
import { summarizeNodeHealth } from "@subboost/core/subscription/node-health";
import { cn } from "@subboost/ui/lib/utils";
import type { ParsedNode } from "@subboost/core/types/node";

type NodeNameParts = {
  baseName: string;
  tag: string;
  template?: string;
  canEditBase: boolean;
};

type DeletedMarkedNode = { originName: string; name: string };

const ORIGIN_NAME_KEY = "_originName";
const NODE_LIST_HEIGHT_CLASS = "space-y-1 max-h-96 overflow-y-auto custom-scrollbar pr-1";

export function NodeManagementNodeList({
  nodes,
  deletedMarkedNodes,
  visibleNodes,
  visibleDeletedMarkedNodes,
  nodeSearchKeyword,
  resolveNodeNameParts,
  editingNodeName,
  setEditingNodeName,
  editNodeValue,
  setEditNodeValue,
  renameNode,
  restoreNodeName,
  listenerPortDrafts,
  setListenerPortDrafts,
  listenerPorts,
  listenerPortErrors,
  setListenerPortErrors,
  commitListenerPort,
  orderDrafts,
  setOrderDrafts,
  nodeIndexByName,
  setNodeOrder,
  moveNode,
  isListenerPortVisible,
  healthCheckingNodes,
  onHealthCheckNode,
  removeNode,
  restoreDeletedNode,
}: {
  nodes: ParsedNode[];
  deletedMarkedNodes: DeletedMarkedNode[];
  visibleNodes: ParsedNode[];
  visibleDeletedMarkedNodes: DeletedMarkedNode[];
  nodeSearchKeyword: string;
  resolveNodeNameParts: (node: ParsedNode) => NodeNameParts;
  editingNodeName: string | null;
  setEditingNodeName: (name: string | null) => void;
  editNodeValue: string;
  setEditNodeValue: (value: string) => void;
  renameNode: (oldName: string, newName: string) => void;
  restoreNodeName: (name: string) => void;
  listenerPortDrafts: Record<string, string>;
  setListenerPortDrafts: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  listenerPorts: Record<string, number>;
  listenerPortErrors: Record<string, string>;
  setListenerPortErrors: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  commitListenerPort: (nodeName: string) => void;
  orderDrafts: Record<string, string>;
  setOrderDrafts: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  nodeIndexByName: Map<string, number>;
  setNodeOrder: (nodeName: string, order: number) => void;
  moveNode: (nodeName: string, direction: "up" | "down") => void;
  isListenerPortVisible: boolean;
  healthCheckingNodes: string[];
  onHealthCheckNode: (nodeName: string) => void;
  removeNode: (nodeName: string) => void;
  restoreDeletedNode: (originName: string) => void;
}) {
  return (
    <>
          {nodes.length === 0 && deletedMarkedNodes.length === 0 ? (
            <div className="text-xs text-white/40 py-4 text-center">请先在上方导入节点</div>
          ) : nodeSearchKeyword.trim() && visibleNodes.length === 0 && visibleDeletedMarkedNodes.length === 0 ? (
            <div className="text-xs text-white/40 py-4 text-center">未找到匹配节点</div>
          ) : (
            <div className={NODE_LIST_HEIGHT_CLASS}>
              {visibleNodes.map((node) => {
                const parts = resolveNodeNameParts(node);
                const primaryTag = parts.canEditBase ? parts.tag : "";
                const record = node as unknown as Record<string, unknown>;
                const originName = typeof record[ORIGIN_NAME_KEY] === "string" && String(record[ORIGIN_NAME_KEY]).trim()
                  ? String(record[ORIGIN_NAME_KEY]).trim()
                  : "";
                const isRenamed = originName && originName !== parts.baseName;
                const cfMark = getCfPreferredMark(node);
                const isCfClone = cfMark === "clone";
                const storedName =
                  isCfClone && node.name.endsWith("-CF") ? node.name.slice(0, -3) : node.name;
                const cfTitle = cfMark
                  ? `${cfMark === "clone" ? "CF 优选副本" : "CF 优选已替换入口"}: ${node.server}`
                  : undefined;

                const commitRename = () => {
                  const base = editNodeValue.trim();
                  if (!base) return;

                  if (parts.tag && !parts.canEditBase) {
                    toast({
                      title: "无法重命名该节点",
                      description:
                        "当前节点命名模板无法解析 {name}；请在导入源高级编辑中调整模板并重新导入后再重命名",
                      variant: "warning",
                    });
                    return;
                  }

                  const originBase = isCfClone && base.endsWith("-CF") ? base.slice(0, -3) : base;
                  const nextName = parts.tag
                    ? formatNodeNameFromTemplate({ originName: originBase, tag: parts.tag, template: parts.template })
                    : originBase;
                  renameNode(storedName, nextName);
                };

                return (
                  <div
                    key={node.name}
                    className="flex items-center gap-2 text-xs bg-white/5 rounded px-2 py-1.5 group"
                  >
                    {editingNodeName === node.name ? (
                      <>
                        <ProtocolBadge type={node.type} />
                        {primaryTag && (
                          <span
                            className="px-1.5 py-0.5 rounded bg-indigo-500/20 text-indigo-200 text-[10px] border border-indigo-500/20"
                            title={`导入源 tag：${primaryTag}（不可在节点管理修改）`}
                          >
                            {primaryTag}
                          </span>
                        )}
                        <Input
                          value={editNodeValue}
                          onChange={(e) => setEditNodeValue(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              commitRename();
                              setEditingNodeName(null);
                            } else if (e.key === "Escape") {
                              setEditingNodeName(null);
                            }
                          }}
                          className="flex-1 h-6 text-xs bg-white/10"
                          autoFocus
                        />
                        <IconButton
                          label="保存节点名称"
                          variant="ghost"
                          onClick={() => {
                            commitRename();
                            setEditingNodeName(null);
                          }}
                          className="h-6 w-6 p-1 text-green-400 hover:text-green-300"
                        >
                          <Check className="h-3 w-3" />
                        </IconButton>
                        <IconButton
                          label="取消重命名"
                          variant="ghost"
                          onClick={() => setEditingNodeName(null)}
                          className="h-6 w-6 p-1 text-white/30 hover:text-white/50"
                        >
                          <X className="h-3 w-3" />
                        </IconButton>
                      </>
                    ) : (
                      <>
                        <ProtocolBadge type={node.type} />
                        <span className="flex-1 min-w-0 flex items-center gap-1">
                          {primaryTag && (
                            <span
                              className="px-1.5 py-0.5 rounded bg-indigo-500/20 text-indigo-200 text-[10px] border border-indigo-500/20"
                              title={`导入源 tag：${primaryTag}（不可在节点管理修改）`}
                            >
                              {primaryTag}
                            </span>
                          )}
                          <span className="text-white truncate" title={cfTitle ? `${node.name} · ${cfTitle}` : node.name}>
                            {parts.canEditBase ? parts.baseName : node.name}
                          </span>
                          {cfMark ? (
                            <span
                              className="shrink-0 rounded border border-amber-500/40 bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-300"
                              title={cfTitle}
                            >
                              {cfMark === "clone" ? "CF 副本" : "CF 优选"}
                            </span>
                          ) : null}
                          {isRenamed && !isCfClone && (
                            <IconButton
                              label={`恢复原名: ${originName}`}
                              variant="ghost"
                              onClick={() => restoreNodeName(storedName)}
                              className="h-5 w-5 p-0.5 text-white/30 transition-colors hover:text-amber-400"
                            >
                              <RotateCcw className="h-2.5 w-2.5" />
                            </IconButton>
                          )}
                        </span>
                        {(() => {
                          const summary = summarizeNodeHealth(node);
                          if (summary.status === "untested") return null;
                          const label =
                            summary.status === "ok"
                              ? `${summary.delayMs}ms`
                              : summary.status === "fail"
                                ? "失败"
                                : "不支持";
                          const color =
                            summary.status === "ok"
                              ? "text-emerald-300"
                              : summary.status === "fail"
                                ? "text-red-400"
                                : "text-white/40";
                          return (
                            <span
                              className={`text-[10px] font-mono whitespace-nowrap flex-shrink-0 ${color}`}
                              title={
                                summary.checkedAt
                                  ? `最近测活：${new Date(summary.checkedAt).toLocaleString()}`
                                  : undefined
                              }
                            >
                              {label}
                            </span>
                          );
                        })()}
                        <IconButton
                          label={
                            healthCheckingNodes.includes(storedName)
                              ? "测活中..."
                              : isCfClone
                                ? "测活原节点（CF 副本随订阅生成，测活走原节点）"
                                : "测活该节点"
                          }
                          variant="ghost"
                          onClick={() => onHealthCheckNode(storedName)}
                          disabled={healthCheckingNodes.length > 0}
                          className="h-6 w-6 flex-shrink-0 p-1 text-white/40 transition-colors hover:bg-white/5 hover:text-emerald-300 disabled:opacity-60"
                        >
                          {healthCheckingNodes.includes(storedName) ? (
                            <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
                          ) : (
                            <Activity className="h-3 w-3" aria-hidden="true" />
                          )}
                        </IconButton>
                        {isListenerPortVisible && (
                          <>
                            <span className="text-[10px] text-white/40 whitespace-nowrap">监听端口:</span>
                            <Input
                              value={
                                Object.prototype.hasOwnProperty.call(listenerPortDrafts, node.name)
                                  ? listenerPortDrafts[node.name]
                                  : typeof listenerPorts[node.name] === "number"
                                    ? String(listenerPorts[node.name])
                                    : ""
                              }
                              onChange={(e) => {
                                const v = e.target.value;
                                setListenerPortDrafts((prev) => ({ ...prev, [node.name]: v }));
                                setListenerPortErrors((prev) => {
                                  if (!Object.prototype.hasOwnProperty.call(prev, node.name)) return prev;
                                  const { [node.name]: _removed, ...rest } = prev;
                                  return rest;
                                });
                              }}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") commitListenerPort(node.name);
                                if (e.key === "Escape") {
                                  setListenerPortDrafts((prev) => {
                                    if (!Object.prototype.hasOwnProperty.call(prev, node.name)) return prev;
                                    const { [node.name]: _removed, ...rest } = prev;
                                    return rest;
                                  });
                                  setListenerPortErrors((prev) => {
                                    if (!Object.prototype.hasOwnProperty.call(prev, node.name)) return prev;
                                    const { [node.name]: _removed, ...rest } = prev;
                                    return rest;
                                  });
                                }
                              }}
                              onBlur={() => commitListenerPort(node.name)}
                              inputMode="numeric"
                              placeholder="-"
                              title={listenerPortErrors[node.name] || "为该节点生成 listeners（mixed）本地监听端口"}
                              className={cn(
                                "h-6 w-16 md:w-[4.5rem] text-[10px] bg-white/10 border-white/10 text-center",
                                listenerPortErrors[node.name] && "border-red-500/30 focus:border-red-500/50"
                              )}
                            />
                          </>
                        )}
                        <span className="text-[10px] text-white/40 whitespace-nowrap">顺序:</span>
                        <div className="flex items-center gap-0.5">
                          <Input
                            value={
                              Object.prototype.hasOwnProperty.call(orderDrafts, storedName)
                                ? orderDrafts[storedName]
                                : String((nodeIndexByName.get(storedName) ?? 0) + 1)
                            }
                            onChange={(e) => setOrderDrafts((prev) => ({ ...prev, [storedName]: e.target.value }))}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") {
                                const val = parseInt(orderDrafts[storedName] ?? "", 10);
                                if (Number.isFinite(val)) setNodeOrder(storedName, val);
                                setOrderDrafts((prev) => {
                                  const { [storedName]: _removed, ...rest } = prev;
                                  return rest;
                                });
                              }
                              if (e.key === "Escape") {
                                setOrderDrafts((prev) => {
                                  const { [storedName]: _removed, ...rest } = prev;
                                  return rest;
                                });
                              }
                            }}
                            onBlur={() => {
                              const val = parseInt(orderDrafts[storedName] ?? "", 10);
                              if (Number.isFinite(val)) setNodeOrder(storedName, val);
                              setOrderDrafts((prev) => {
                                const { [storedName]: _removed, ...rest } = prev;
                                return rest;
                              });
                            }}
                            inputMode="numeric"
                            title={isCfClone ? "CF 副本跟随原节点排序" : "排序位置（1=最前）"}
                            className="h-6 w-10 text-[10px] bg-white/10 border-white/10 text-center px-1"
                          />
                          <div className="flex flex-col">
                            <IconButton
                              label="上移节点"
                              variant="ghost"
                              onClick={() => moveNode(storedName, "up")}
                              disabled={(nodeIndexByName.get(storedName) ?? 0) <= 0}
                              className="h-3 w-4 flex items-center justify-center text-white/30 hover:text-indigo-300 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                            >
                              <ChevronUp className="h-2.5 w-2.5" />
                            </IconButton>
                            <IconButton
                              label="下移节点"
                              variant="ghost"
                              onClick={() => moveNode(storedName, "down")}
                              disabled={(nodeIndexByName.get(storedName) ?? 0) >= Math.max(0, nodeIndexByName.size - 1)}
                              className="h-3 w-4 flex items-center justify-center text-white/30 hover:text-indigo-300 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                            >
                              <ChevronDown className="h-2.5 w-2.5" />
                            </IconButton>
                          </div>
                        </div>
                        <IconButton
                          label={isCfClone ? "重命名原节点（副本名称会跟着变）" : "重命名节点"}
                          variant="ghost"
                          onClick={() => {
                            if (parts.tag && !parts.canEditBase) {
                              toast({
                                title: "无法重命名该节点",
                                description:
                                  "当前节点命名模板无法解析 {name}；请在导入源高级编辑中调整模板并重新导入后再重命名",
                                variant: "warning",
                              });
                              return;
                            }
                            const base = parts.baseName;
                            setEditingNodeName(node.name);
                            setEditNodeValue(isCfClone && base.endsWith("-CF") ? base.slice(0, -3) : base);
                          }}
                          className="h-6 w-6 p-1 text-white/50 hover:text-indigo-400 transition-colors"
                        >
                          <Pencil className="h-3 w-3" />
                        </IconButton>
                        <IconButton
                          label={isCfClone ? "删除原节点及其 CF 副本" : "删除节点"}
                          variant="ghost"
                          onClick={() => removeNode(storedName)}
                          className="h-6 w-6 p-1 text-white/50 hover:text-red-400 transition-colors"
                        >
                          <Trash2 className="h-3 w-3" />
                        </IconButton>
                      </>
                    )}
                  </div>
                );
              })}

              {visibleDeletedMarkedNodes.length > 0 && (
                <div
                  className={cn(
                    "pt-2 mt-2 border-t border-white/10",
                    visibleNodes.length === 0 && "pt-0 mt-0 border-t-0"
                  )}
                >
                  <div className="text-[10px] text-white/40 mb-1">
                    已删除节点（不会生成到配置；点击“恢复”可立即恢复；若缺少来源信息可能需要重新导入）
                  </div>
                  <div className="space-y-1">
                    {visibleDeletedMarkedNodes.map(({ originName, name }) => (
                      <div
                        key={`deleted:${originName}`}
                        className="flex items-center gap-2 text-xs bg-red-500/10 border border-red-500/20 rounded px-2 py-1.5"
                      >
                        <span className="text-red-400 text-[10px] w-4">DEL</span>
                        <div className="flex-1 min-w-0">
                          <div className="text-white/50 line-through truncate" title={name}>
                            {name}
                          </div>
                          {originName !== name && (
                            <div className="text-[10px] text-white/30 truncate" title={`源名: ${originName}`}>
                              源名: {originName}
                            </div>
                          )}
                        </div>
                        <Badge
                          variant="outline"
                          className="h-5 px-2 text-[10px] font-medium border-red-500/50 bg-red-500/10 text-red-300"
                        >
                          已删除
                        </Badge>
                        <IconButton
                          label={`恢复节点 ${originName}`}
                          variant="ghost"
                          onClick={() => restoreDeletedNode(originName)}
                          className="h-6 w-6 p-1 text-white/30 hover:text-white/60"
                        >
                          <RotateCcw className="h-3 w-3" />
                        </IconButton>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
    </>
  );
}
