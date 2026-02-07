import { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '../../lobby/components/ui/dialog';
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from '../../lobby/components/ui/collapsible';
import { Badge } from '../../lobby/components/ui/badge';
import { ArchetypeBadge } from '../../lobby/features/lobby/ArchetypeBadge';
import { useStrategyInspectorStore } from '../stores/strategyInspectorStore';
import { AIActionType } from '../../../shared/types/AITypes';
import type { FeasibleOption, TurnPlan } from '../../../shared/types/AITypes';

function ActionTypeLabel({ type }: { type: AIActionType }) {
  const labels: Record<AIActionType, string> = {
    [AIActionType.DeliverLoad]: 'Deliver Load',
    [AIActionType.PickupAndDeliver]: 'Pickup & Deliver',
    [AIActionType.BuildTrack]: 'Build Track',
    [AIActionType.UpgradeTrain]: 'Upgrade Train',
    [AIActionType.BuildTowardMajorCity]: 'Build Toward City',
    [AIActionType.PassTurn]: 'Pass Turn',
  };
  return <span>{labels[type] ?? type}</span>;
}

function CurrentPlanSection({ plan }: { plan: TurnPlan }) {
  return (
    <section aria-labelledby="current-plan-heading">
      <h3 id="current-plan-heading" className="text-sm font-semibold mb-2">
        Current Plan
      </h3>
      <div className="space-y-2">
        {plan.actions.map((action, i) => (
          <div
            key={i}
            className="flex items-center gap-2 rounded-md border bg-muted/30 px-3 py-2 text-sm"
          >
            <Badge variant="secondary" className="text-xs shrink-0">
              {i + 1}
            </Badge>
            <ActionTypeLabel type={action.type} />
            {action.parameters.payment != null && (
              <span className="text-muted-foreground ml-auto">
                +${String(action.parameters.payment)}M
              </span>
            )}
            {action.parameters.estimatedCost != null && (
              <span className="text-muted-foreground ml-auto">
                -${String(action.parameters.estimatedCost)}M
              </span>
            )}
          </div>
        ))}
      </div>
      <div className="mt-2 grid grid-cols-2 gap-2 text-xs text-muted-foreground">
        <div>Score: {plan.totalScore.toFixed(1)}</div>
        <div>Cash change: {plan.expectedOutcome.cashChange >= 0 ? '+' : ''}{plan.expectedOutcome.cashChange}M</div>
        <div>Loads delivered: {plan.expectedOutcome.loadsDelivered}</div>
        <div>Track built: {plan.expectedOutcome.trackSegmentsBuilt}</div>
      </div>
    </section>
  );
}

function OptionsTable({ options, label }: { options: readonly FeasibleOption[]; label: string }) {
  if (options.length === 0) {
    return <p className="text-sm text-muted-foreground">No {label.toLowerCase()}.</p>;
  }

  return (
    <div className="overflow-x-auto" role="table" aria-label={label}>
      <div className="min-w-[400px]">
        <div className="grid grid-cols-[1fr_auto_auto] gap-2 text-xs font-medium text-muted-foreground border-b pb-1 mb-1" role="row">
          <div role="columnheader">Action</div>
          <div role="columnheader" className="text-right">Score</div>
          <div role="columnheader" className="text-right">Details</div>
        </div>
        {options.map((opt) => (
          <div
            key={opt.id}
            className="grid grid-cols-[1fr_auto_auto] gap-2 py-1.5 text-sm border-b border-border/50 last:border-0"
            role="row"
          >
            <div className="flex items-center gap-1.5" role="cell">
              <ActionTypeLabel type={opt.type} />
              {!opt.feasible && opt.rejectionReason && (
                <span className="text-xs text-destructive truncate max-w-[180px]" title={opt.rejectionReason}>
                  ({opt.rejectionReason})
                </span>
              )}
            </div>
            <div className="text-right tabular-nums" role="cell">
              {opt.feasible ? opt.score.toFixed(1) : '-'}
            </div>
            <div className="text-right text-muted-foreground text-xs" role="cell">
              {opt.parameters.payment != null && `+$${String(opt.parameters.payment)}M`}
              {opt.parameters.estimatedCost != null && `-$${String(opt.parameters.estimatedCost)}M`}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function CollapsibleSection({
  title,
  count,
  defaultOpen = true,
  children,
}: {
  title: string;
  count: number;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const headingId = `section-${title.replace(/\s+/g, '-').toLowerCase()}`;

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger
        className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-sm font-semibold hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-expanded={open}
        aria-controls={`${headingId}-content`}
      >
        <span id={headingId}>
          {title} ({count})
        </span>
        <span className="text-muted-foreground text-xs" aria-hidden="true">
          {open ? '▾' : '▸'}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent id={`${headingId}-content`} className="px-2 pt-2">
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
}

function TimingFooter({ timing }: { timing: { snapshotMs: number; optionGenerationMs: number; scoringMs: number; executionMs: number; totalMs: number } }) {
  return (
    <div className="flex flex-wrap gap-3 text-xs text-muted-foreground border-t pt-3 mt-3">
      <span>Total: {timing.totalMs}ms</span>
      <span>Snapshot: {timing.snapshotMs}ms</span>
      <span>Options: {timing.optionGenerationMs}ms</span>
      <span>Scoring: {timing.scoringMs}ms</span>
      <span>Execution: {timing.executionMs}ms</span>
    </div>
  );
}

export function StrategyInspectorModal() {
  const { isOpen, playerName, auditData, isLoading, error, close } = useStrategyInspectorStore();

  const feasibleOptions = auditData?.allOptions.filter((o) => o.feasible) ?? [];
  const rejectedOptions = auditData?.allOptions.filter((o) => !o.feasible) ?? [];

  // Sort feasible by score descending
  const sortedFeasible = [...feasibleOptions].sort((a, b) => b.score - a.score);

  return (
    <Dialog open={isOpen} onOpenChange={(open) => { if (!open) close(); }}>
      <DialogContent
        className="sm:max-w-xl max-h-[80vh] overflow-y-auto"
        aria-labelledby="strategy-inspector-title"
      >
        <DialogHeader>
          <div className="flex items-center gap-2 flex-wrap">
            <DialogTitle id="strategy-inspector-title">
              Strategy Inspector
            </DialogTitle>
            {playerName && (
              <Badge variant="outline" className="text-xs">
                {playerName}
              </Badge>
            )}
          </div>
          {auditData?.selectedPlan && (
            <div className="flex items-center gap-2 flex-wrap mt-1">
              <ArchetypeBadge archetype={auditData.selectedPlan.archetype} />
              <Badge variant="secondary" className="text-xs capitalize">
                {auditData.selectedPlan.skillLevel}
              </Badge>
            </div>
          )}
          <DialogDescription>
            Detailed breakdown of the bot&apos;s last turn decisions.
          </DialogDescription>
        </DialogHeader>

        {isLoading && (
          <div className="flex items-center justify-center py-8" role="status" aria-label="Loading audit data">
            <div className="size-6 border-2 border-accent border-t-transparent rounded-full animate-spin" />
            <span className="ml-2 text-sm text-muted-foreground">Loading audit data...</span>
          </div>
        )}

        {error && !isLoading && (
          <div className="rounded-md border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive" role="alert">
            {error}
          </div>
        )}

        {auditData && !isLoading && (
          <div className="space-y-4">
            {auditData.selectedPlan && (
              <CurrentPlanSection plan={auditData.selectedPlan} />
            )}

            <CollapsibleSection
              title="Options Considered"
              count={sortedFeasible.length}
              defaultOpen={true}
            >
              <OptionsTable options={sortedFeasible} label="Options Considered" />
            </CollapsibleSection>

            <CollapsibleSection
              title="Rejected Options"
              count={rejectedOptions.length}
              defaultOpen={false}
            >
              <OptionsTable options={rejectedOptions} label="Rejected Options" />
            </CollapsibleSection>

            {auditData.executionResults.length > 0 && (
              <CollapsibleSection
                title="Execution Results"
                count={auditData.executionResults.length}
                defaultOpen={false}
              >
                <div className="space-y-1">
                  {auditData.executionResults.map((result, i) => (
                    <div
                      key={i}
                      className="flex items-center gap-2 text-sm"
                    >
                      <span className={result.success ? 'text-green-500' : 'text-destructive'}>
                        {result.success ? 'OK' : 'FAIL'}
                      </span>
                      <ActionTypeLabel type={result.actionType} />
                      <span className="text-muted-foreground text-xs ml-auto">
                        {result.durationMs}ms
                      </span>
                      {result.error && (
                        <span className="text-xs text-destructive">{result.error}</span>
                      )}
                    </div>
                  ))}
                </div>
              </CollapsibleSection>
            )}

            <TimingFooter timing={auditData.timing} />
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
