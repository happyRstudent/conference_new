import type { TopicGroup } from "@/lib/models/types";
import { TopicItemCard } from "@/components/TopicItemCard";

interface Props {
  topicGroups: TopicGroup[];
  selectedIndices: number[];
  onSelect: (groupIndex: number, candidateIndex: number) => void;
  onRegenerate: (index: number) => void;
  regeneratingIndex: number | null;
}

export function TopicListEditor({
  topicGroups,
  selectedIndices,
  onSelect,
  onRegenerate,
  regeneratingIndex,
}: Props) {
  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold text-slate-900">请确认并完善议题</h2>
      <p className="text-xs text-slate-500">每组有 3 个候选议题，请为每个议题选择一个。</p>
      <div className="space-y-3">
        {topicGroups.map((group, index) => (
          <TopicItemCard
            key={group.candidates[0]?.id || index}
            group={group}
            index={index}
            selectedIndex={selectedIndices[index] ?? 0}
            onSelect={onSelect}
            onRegenerate={onRegenerate}
            regenerating={regeneratingIndex === index}
          />
        ))}
      </div>
    </section>
  );
}
