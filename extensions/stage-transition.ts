/**
 * Stage Transition — the controlled advance of a Quest along the Stage Pipeline.
 *
 * One place owns: validity check, verification-artifact gate, Launch Gate
 * (ADR 012), Quest Branch capture (ADR 011 §2), workflow write, `stage_entered`
 * audit event (ADR 010), UAT doorbell (ADR 016), and Homecoming Brief
 * regeneration on autonomous-to-interactive boundaries (ADR 015).
 *
 * Called from `/quest set-status` and the `quest_write_workflow` tool. Emergency
 * stops (hard freeze) intentionally do not go through this module — they write
 * a terminal status directly.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { QuestStatus, QuestWorkflow } from "../lib.js";
import { isValidTransition } from "../lib.js";
import { loadQuestWorkflow, saveQuestWorkflow } from "./state.js";
import { questDirPath } from "./paths.js";
import { emitStageEntered } from "./events.js";
import {
	captureQuestBranchOnExecuting,
	fireUatDoorbell,
	regenerateHomecomingBrief,
	runLaunchGate,
} from "./commands.js";
import { isAutonomousToInteractiveTransition } from "./homecoming-brief.js";
import type { EngageSkill } from "./skill-engagement.js";

/**
 * Map of interactive Quest Stages → the skill that owns the user-facing
 * walkthrough for that stage. When `transitionStage` advances into one of these
 * stages, the corresponding skill is auto-engaged so the user lands *in* the
 * skill (issue #4 / friction-elimination principle). Re-entry re-engages
 * every time — there is no per-stage idempotency marker.
 */
const STAGE_SKILL: Partial<Record<QuestStatus, string>> = {
	"launch-review": "quest-launch-review",
	reviewing: "quest-review-discussion",
	"uat-ready": "quest-uat",
};

export type StageTransitionRejection =
	| "quest_not_found"
	| "invalid_transition"
	| "missing_verification_artifact"
	| "launch_gate_blocked"
	| "quest_branch_capture_failed";

export type StageTransitionResult =
	| {
			outcome: "applied";
			previousStatus: QuestStatus;
			newStatus: QuestStatus;
			doorbellFired: boolean;
			workflow: QuestWorkflow;
	  }
	| {
			outcome: "rejected";
			reason: StageTransitionRejection;
			message: string;
			details?: Record<string, unknown>;
	  };

export interface StageTransitionContext {
	cwd: string;
	ui: { notify: (msg: string, level?: "error" | "info" | "warning") => void };
}

/**
 * Silenced ctx for downstream helpers whose notifications would otherwise
 * compete with the structured rejection this module returns. `runLaunchGate`
 * historically notified directly; we own that channel now.
 */
function silentNotify(): StageTransitionContext["ui"] {
	return { notify: () => {} };
}

export async function transitionStage(
	ctx: StageTransitionContext,
	questId: string,
	target: QuestStatus,
	options: { force?: boolean },
	engageSkill?: EngageSkill,
): Promise<StageTransitionResult> {
	const force = !!options.force;
	const questDir = questDirPath(ctx.cwd, questId);
	const workflow = loadQuestWorkflow(questDir);
	if (!workflow) {
		return {
			outcome: "rejected",
			reason: "quest_not_found",
			message: `Quest '${questId}' not found.`,
		};
	}

	if (!force && !isValidTransition(workflow.status, target)) {
		return {
			outcome: "rejected",
			reason: "invalid_transition",
			message: `Invalid status transition: ${workflow.status} → ${target}.`,
			details: { currentStatus: workflow.status, requestedStatus: target },
		};
	}

	if (!force && target === "verification-ready") {
		const verificationRel = workflow.artifacts.verification ?? "VERIFICATION.md";
		const verificationPath = path.join(questDir, verificationRel);
		if (!fs.existsSync(verificationPath)) {
			return {
				outcome: "rejected",
				reason: "missing_verification_artifact",
				message: `Gate check failed: ${verificationRel} not found. Run the Verification Agent before marking verification-ready.`,
				details: {
					currentStatus: workflow.status,
					requestedStatus: target,
					missingArtifact: verificationPath,
				},
			};
		}
	}

	if (workflow.status === "launch-review" && target === "executing") {
		const gateResult = runLaunchGate(
			{ ui: silentNotify() },
			questId,
			questDir,
			workflow,
			force,
		);
		if (gateResult.outcome === "blocked") {
			return {
				outcome: "rejected",
				reason: "launch_gate_blocked",
				message: `Launch Gate blocked: ${gateResult.reasons.join(", ")}.`,
				details: {
					currentStatus: workflow.status,
					requestedStatus: target,
					reasons: gateResult.reasons,
				},
			};
		}
	}

	try {
		await captureQuestBranchOnExecuting(ctx.cwd, workflow, target);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return {
			outcome: "rejected",
			reason: "quest_branch_capture_failed",
			message: `Quest Branch capture failed: ${msg}`,
			details: { currentStatus: workflow.status, requestedStatus: target },
		};
	}

	const previousStatus = workflow.status;
	workflow.status = target;
	workflow.updatedAt = new Date().toISOString();
	saveQuestWorkflow(questDir, workflow);
	emitStageEntered(questDir, questId, previousStatus, workflow.status);

	const doorbellFired = fireUatDoorbell(ctx, workflow, questDir, previousStatus);

	if (isAutonomousToInteractiveTransition(previousStatus, workflow.status)) {
		await regenerateHomecomingBrief(ctx, questId);
	}

	const skillName = STAGE_SKILL[workflow.status];
	if (skillName && engageSkill) {
		await engageSkill(skillName);
	}

	return {
		outcome: "applied",
		previousStatus,
		newStatus: workflow.status,
		doorbellFired,
		workflow,
	};
}
