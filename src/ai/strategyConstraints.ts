import { type Ctx } from "./analysis.js";
import { type SolveInput } from "./solver.js";

/**
 * 双小对双大的产品策略边界。选牌、当前下注和下一局估值共用，
 * 不把「对手可能弃掉必赢牌」当成扩大底池的理由。
 * 2 的例外只按公开选牌范围和本局命数效用算，不用留牌奖励放行。
 */
export function bettingConstraint(
  mine: Ctx,
  opponent: Ctx,
  oppPrior: number[],
  utility: (delta: number) => number
): NonNullable<SolveInput["allowAction"]> {
  const total = oppPrior.reduce((s, p) => s + p, 0);
  const priorAce = total > 0 ? (oppPrior[14] ?? 0) / total : 0;
  const values = new Map<number, number>();
  const u = (d: number) => {
    if (!values.has(d)) values.set(d, utility(d));
    return values.get(d)!;
  };
  const allow: NonNullable<SolveInput["allowAction"]> = (rank, action, sMe, sOpp, range) => {
    if (mine !== "DOWN2" || opponent !== "UP2" || rank >= 8) return true;
    if (action.type === "check" || action.type === "fold") return true;
    if (rank !== 2) return false;
    const ace = range ? range[14] : priorAce;
    const showdown = (stake: number) => ace * u(stake) + (1 - ace) * u(-stake);
    if (action.type === "call") return showdown(sOpp) > u(-sMe) + 1e-12;
    // 主动进攻必须具有摊牌优势，并优于过牌/弃牌及跟注的保守基准。
    const passive = sOpp > sMe ? Math.max(u(-sMe), showdown(sOpp)) : showdown(sMe);
    return ace > 0.5 && showdown(action.raiseTo!) > passive + 1e-12;
  };
  // 仅 2 需要随节点证据更新；3～7 的静态硬边界不随对手策略松动。
  allow.conditionedRanks = mine === "DOWN2" && opponent === "UP2" ? [2] : [];
  return allow;
}
