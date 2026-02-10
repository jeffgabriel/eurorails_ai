import * as React from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '../ui/dialog';
import { cn } from '../ui/utils';
import { ScoreBar } from './ScoreBar';
import { ArchetypeBadge } from './ArchetypeBadge';
import type { ArchetypeId } from '../../../../server/ai/types';
import type {
  StrategyAudit,
  ScoredOption,
  InfeasibleOption,
  SkillLevel,
} from '../../../../server/ai/types';
import { TrainType } from '../../../../shared/types/GameTypes';

// --- Archetype Descriptions ---

const ARCHETYPE_PHILOSOPHY: Record<string, string> = {
  backbone_builder: 'Build the highway first, then add the on-ramps.',
  freight_optimizer: 'Never move empty; every milepost should earn money.',
  trunk_sprinter: 'Speed kills \u2014 the fastest train on the shortest route wins.',
  continental_connector: 'Victory is about the network, not the next delivery.',
  opportunist: 'Play the cards you\'re dealt, not the cards you wish you had.',
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

// --- Sub-components ---

interface CurrentPlanSectionProps {
  currentPlan: string;
  archetypeRationale: string;
}

function CurrentPlanSection({ currentPlan, archetypeRationale }: CurrentPlanSectionProps) {
  return (
    <div data-slot="current-plan" className="rounded-md border p-4">
      <h3 className="text-sm font-semibold mb-2">Current Plan</h3>
      <p className="text-sm">{currentPlan}</p>
      {archetypeRationale && (
        <p className="text-muted-foreground text-xs mt-2 italic">
          [{archetypeRationale}]
        </p>
      )}
    </div>
  );
}

interface OptionsTableProps {
  options: ScoredOption[];
}

function OptionsTable({ options }: OptionsTableProps) {
  if (options.length === 0) {
    return (
      <div data-slot="options-table" className="text-muted-foreground text-sm">
        No feasible options evaluated.
      </div>
    );
  }

  const maxScore = Math.max(...options.map((o) => o.score), 1);

  return (
    <div data-slot="options-table">
      <h3 className="text-sm font-semibold mb-2">Options Considered</h3>
      <div className="space-y-2">
        {options.map((option, index) => (
          <div
            key={index}
            data-slot="option-row"
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
            <div className="w-20 shrink-0">
              <ScoreBar score={option.score} maxScore={maxScore} />
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

interface RejectedOptionsSectionProps {
  options: InfeasibleOption[];
}

function RejectedOptionsSection({ options }: RejectedOptionsSectionProps) {
  const [isOpen, setIsOpen] = React.useState(false);

  if (options.length === 0) return null;

  return (
    <div data-slot="rejected-options">
      <button
        type="button"
        data-slot="rejected-toggle"
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
              data-slot="rejected-row"
              className="flex items-start gap-2 rounded-md border border-dashed p-2 text-sm"
              role="listitem"
            >
              <span className="text-muted-foreground shrink-0">\u274C</span>
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

interface BotStatusSummaryProps {
  botStatus: StrategyAudit['botStatus'];
  turnNumber: number;
  durationMs: number;
}

function BotStatusSummary({ botStatus, turnNumber, durationMs }: BotStatusSummaryProps) {
  return (
    <div data-slot="bot-status" className="grid grid-cols-2 gap-x-4 gap-y-1 rounded-md border p-3 text-sm">
      <div className="text-muted-foreground">Cash</div>
      <div className="font-medium">{botStatus.cash}M ECU</div>
      <div className="text-muted-foreground">Train</div>
      <div className="font-medium">{TRAIN_LABELS[botStatus.trainType] || botStatus.trainType}</div>
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

export interface StrategyInspectorModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  audit: StrategyAudit | null;
  botName?: string;
}

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
              No strategy data available yet. The bot hasn&apos;t taken a turn.
            </DialogDescription>
          </DialogHeader>
        </DialogContent>
      </Dialog>
    );
  }

  const archetypeId = audit.archetypeName
    .toLowerCase()
    .replace(/\s+/g, '_') as ArchetypeId;
  const philosophy = ARCHETYPE_PHILOSOPHY[archetypeId] || '';
  const skillLabel = SKILL_LABELS[audit.skillLevel] || audit.skillLevel;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <ArchetypeBadge archetype={archetypeId} />
            <DialogTitle>
              {botName || audit.archetypeName}
            </DialogTitle>
            <span
              data-slot="skill-badge"
              className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium"
            >
              {skillLabel}
            </span>
          </div>
          <DialogDescription>{philosophy}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <CurrentPlanSection
            currentPlan={audit.currentPlan}
            archetypeRationale={audit.archetypeRationale}
          />

          <OptionsTable options={audit.feasibleOptions} />

          <RejectedOptionsSection options={audit.rejectedOptions} />

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
