import * as React from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '../ui/dialog';
import { cn } from '../ui/utils';
import {
  AIActionType,
  TurnPlan,
  LLMDecisionResult,
  TrainType,
} from '../../../../shared/types/GameTypes';

// --- Labels ---

const ACTION_TYPE_LABELS: Record<string, string> = {
  [AIActionType.DeliverLoad]: 'Deliver Load',
  [AIActionType.PickupLoad]: 'Pickup Load',
  [AIActionType.DropLoad]: 'Drop Load',
  [AIActionType.BuildTrack]: 'Build Track',
  [AIActionType.UpgradeTrain]: 'Upgrade Train',
  [AIActionType.MoveTrain]: 'Move Train',
  [AIActionType.PassTurn]: 'Pass Turn',
  [AIActionType.DiscardHand]: 'Discard Hand',
  MultiAction: 'Multi-Action',
};

const SKILL_LABELS: Record<string, string> = {
  easy: 'Easy',
  medium: 'Medium',
  hard: 'Hard',
};

const TRAIN_LABELS: Record<string, string> = {
  [TrainType.Freight]: 'Freight',
  [TrainType.FastFreight]: 'Fast Freight',
  [TrainType.HeavyFreight]: 'Heavy Freight',
  [TrainType.Superfreight]: 'Superfreight',
};

// --- Types ---

interface BotStatus {
  cash: number;
  trainType: string;
  loads: string[];
  majorCitiesConnected: number;
}

/** Existing v5/v6.2 audit format from the database */
interface StrategyAudit {
  turnNumber: number;
  skillLevel: string;
  snapshotHash: string;
  currentPlan: string;
  feasibleOptions: Array<{
    description: string;
    rationale: string;
    score: number;
  }>;
  rejectedOptions: Array<{
    description: string;
    reason: string;
  }>;
  selectedPlan: unknown;
  executionResult: unknown;
  botStatus: BotStatus;
  durationMs: number;
  /** New v6.3 field: LLM decision result (optional for backward compat) */
  llmDecision?: LLMDecisionResult;
}

interface StrategyInspectorModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  audit: StrategyAudit | null;
  botName?: string;
}

// --- Sub-components ---

function ActionTypeLabel({ type }: { type: string }) {
  return <span>{ACTION_TYPE_LABELS[type] ?? type}</span>;
}

function PlanDisplay({ plan }: { plan: TurnPlan }) {
  if (plan.type === 'MultiAction') {
    return (
      <div className="space-y-1">
        {plan.steps.map((step, i) => (
          <div
            key={i}
            className="flex items-center gap-2 rounded-md border bg-muted/30 px-3 py-2 text-sm"
          >
            <span className="text-muted-foreground text-xs font-mono w-5 text-right shrink-0">
              {i + 1}.
            </span>
            <ActionTypeLabel type={step.type} />
            <PlanStepDetails plan={step} />
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 rounded-md border bg-muted/30 px-3 py-2 text-sm">
      <ActionTypeLabel type={plan.type} />
      <PlanStepDetails plan={plan} />
    </div>
  );
}

function PlanStepDetails({ plan }: { plan: TurnPlan }) {
  switch (plan.type) {
    case AIActionType.BuildTrack:
      return (
        <span className="text-muted-foreground ml-auto text-xs">
          {plan.segments.length} segment{plan.segments.length !== 1 ? 's' : ''}
        </span>
      );
    case AIActionType.MoveTrain:
      return (
        <span className="text-muted-foreground ml-auto text-xs">
          {plan.path.length} milepost{plan.path.length !== 1 ? 's' : ''}
          {plan.totalFee > 0 && ` | fee: $${plan.totalFee}M`}
        </span>
      );
    case AIActionType.DeliverLoad:
      return (
        <span className="text-muted-foreground ml-auto text-xs">
          {plan.load} to {plan.city} (+${plan.payout}M)
        </span>
      );
    case AIActionType.PickupLoad:
      return (
        <span className="text-muted-foreground ml-auto text-xs">
          {plan.load} at {plan.city}
        </span>
      );
    case AIActionType.UpgradeTrain:
      return (
        <span className="text-muted-foreground ml-auto text-xs">
          {plan.targetTrain} (-${plan.cost}M)
        </span>
      );
    default:
      return null;
  }
}

function LLMDecisionSection({ decision }: { decision: LLMDecisionResult }) {
  return (
    <section aria-labelledby="llm-decision-heading" className="space-y-3">
      <h3 id="llm-decision-heading" className="text-sm font-semibold">
        LLM Decision
      </h3>

      {/* Action plan */}
      <div>
        <div className="text-xs text-muted-foreground mb-1">Action</div>
        <PlanDisplay plan={decision.plan} />
      </div>

      {/* Reasoning */}
      {decision.reasoning && (
        <div>
          <div className="text-xs text-muted-foreground mb-1">Reasoning</div>
          <p className="text-sm rounded-md border bg-muted/20 px-3 py-2">
            {decision.reasoning}
          </p>
        </div>
      )}

      {/* Plan Horizon */}
      {decision.planHorizon && (
        <div>
          <div className="text-xs text-muted-foreground mb-1">Plan Horizon</div>
          <p className="text-sm">{decision.planHorizon}</p>
        </div>
      )}

      {/* Metadata footer */}
      <div className="flex flex-wrap gap-3 text-xs text-muted-foreground border-t pt-2">
        <span>Model: {decision.model}</span>
        <span>Latency: {decision.latencyMs}ms</span>
        {decision.tokenUsage && (
          <span>
            Tokens: {decision.tokenUsage.input}in / {decision.tokenUsage.output}out
          </span>
        )}
        {decision.retried && <span className="text-yellow-600">Retried</span>}
        {decision.guardrailOverride && (
          <span className="text-orange-600">Guardrail Override</span>
        )}
      </div>
    </section>
  );
}

/** Legacy ranked options display (v5/v6.2 format) */
function OptionsTable({ options }: { options: StrategyAudit['feasibleOptions'] }) {
  if (options.length === 0) {
    return (
      <div className="text-muted-foreground text-sm">
        No feasible options evaluated.
      </div>
    );
  }

  return (
    <div>
      <h3 className="text-sm font-semibold mb-2">Options Considered</h3>
      <div className="space-y-2">
        {options.map((option, index) => (
          <div
            key={index}
            className={cn(
              'flex items-center gap-3 rounded-md border p-2 text-sm',
              index === 0 && 'border-primary/50 bg-primary/5',
            )}
          >
            <span className="text-muted-foreground w-6 text-right shrink-0">
              {index === 0 ? '\u2705' : `#${index + 1}`}
            </span>
            <div className="flex-1 min-w-0">
              <div className="font-medium truncate">{option.description}</div>
              <div className="text-muted-foreground text-xs truncate">
                {option.rationale}
              </div>
            </div>
            <span className="text-xs font-mono w-8 text-right shrink-0">
              {Math.round(option.score)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function RejectedOptionsSection({
  options,
}: {
  options: StrategyAudit['rejectedOptions'];
}) {
  const [isOpen, setIsOpen] = React.useState(false);
  if (options.length === 0) return null;

  return (
    <div>
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
        aria-expanded={isOpen}
        aria-controls="rejected-options-list"
      >
        <span className="text-xs">{isOpen ? '\u25BC' : '\u25B6'}</span>
        Rejected Options ({options.length})
      </button>
      {isOpen && (
        <div id="rejected-options-list" className="mt-2 space-y-1" role="list">
          {options.map((option, index) => (
            <div
              key={index}
              className="flex items-start gap-2 rounded-md border border-dashed p-2 text-sm"
              role="listitem"
            >
              <span className="text-muted-foreground shrink-0">{'\u274C'}</span>
              <div className="min-w-0">
                <div className="font-medium">{option.description}</div>
                <div className="text-muted-foreground text-xs">{option.reason}</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function BotStatusSummary({
  botStatus,
  turnNumber,
  durationMs,
}: {
  botStatus: BotStatus;
  turnNumber: number;
  durationMs: number;
}) {
  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-1 rounded-md border p-3 text-sm">
      <div className="text-muted-foreground">Cash</div>
      <div className="font-medium">{botStatus.cash}M ECU</div>
      <div className="text-muted-foreground">Train</div>
      <div className="font-medium">
        {TRAIN_LABELS[botStatus.trainType] || botStatus.trainType}
      </div>
      <div className="text-muted-foreground">Loads</div>
      <div className="font-medium">
        {botStatus.loads.length > 0 ? botStatus.loads.join(', ') : 'None'}
      </div>
      <div className="text-muted-foreground">Major Cities</div>
      <div className="font-medium">{botStatus.majorCitiesConnected}</div>
      <div className="text-muted-foreground">Turn</div>
      <div className="font-medium">{turnNumber}</div>
      <div className="text-muted-foreground">Think Time</div>
      <div className="font-medium">{(durationMs / 1000).toFixed(1)}s</div>
    </div>
  );
}

// --- Main Component ---

export function StrategyInspectorModal({
  open,
  onOpenChange,
  audit,
  botName,
}: StrategyInspectorModalProps) {
  if (!audit) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Strategy Inspector</DialogTitle>
            <DialogDescription>
              No strategy data available yet. The bot hasn't taken a turn.
            </DialogDescription>
          </DialogHeader>
        </DialogContent>
      </Dialog>
    );
  }

  const skillLabel = SKILL_LABELS[audit.skillLevel] || audit.skillLevel;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <DialogTitle>{botName || 'Bot'}</DialogTitle>
            <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium">
              {skillLabel}
            </span>
          </div>
        </DialogHeader>

        <div className="space-y-4">
          {/* v6.3: LLM Decision Result (new format) */}
          {audit.llmDecision && (
            <LLMDecisionSection decision={audit.llmDecision} />
          )}

          {/* Legacy: Current Plan (string description) — shown when no LLM decision */}
          {!audit.llmDecision && audit.currentPlan && (
            <div className="rounded-md border p-4">
              <h3 className="text-sm font-semibold mb-2">Current Plan</h3>
              <p className="text-sm">{audit.currentPlan}</p>
            </div>
          )}

          {/* Legacy: Ranked options — shown when no LLM decision */}
          {!audit.llmDecision && (
            <>
              <OptionsTable options={audit.feasibleOptions} />
              <RejectedOptionsSection options={audit.rejectedOptions} />
            </>
          )}

          {/* Bot Status — always shown */}
          <BotStatusSummary
            botStatus={audit.botStatus}
            turnNumber={audit.turnNumber}
            durationMs={audit.durationMs}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}
