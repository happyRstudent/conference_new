import type { TopicGroup } from "@/lib/models/types";

interface Props {
  index: number;
  group: TopicGroup;
  selectedIndex: number;
  onSelect: (groupIndex: number, candidateIndex: number) => void;
  onRegenerate: (index: number) => void;
  regenerating: boolean;
}

export function TopicItemCard({
  index,
  group,
  selectedIndex,
  onSelect,
  onRegenerate,
  regenerating,
}: Props) {
  const safeIndex = Math.min(selectedIndex, Math.max(0, group.candidates.length - 1));
  const selected = group.candidates[safeIndex];

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-800">议题 {index + 1}</h3>
        <button
          type="button"
          onClick={() => onRegenerate(index)}
          disabled={regenerating}
          className="rounded border border-slate-300 px-3 py-1 text-xs text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-70"
        >
          {regenerating ? "生成中..." : "重新生成"}
        </button>
      </div>

      <div className="space-y-2">
        {group.candidates.map((candidate, ci) => (
          <button
            key={candidate.id}
            type="button"
            onClick={() => onSelect(index, ci)}
            className={`w-full rounded-md border px-3 py-2 text-left text-sm transition-colors ${
              ci === safeIndex
                ? "border-slate-900 bg-slate-50 ring-1 ring-slate-900"
                : "border-slate-200 hover:border-slate-400"
            }`}
          >
            <span className="mr-2 text-xs text-slate-400">候选 {ci + 1}</span>
            <span className={ci === safeIndex ? "font-medium text-slate-900" : "text-slate-700"}>
              {candidate.title}
            </span>
          </button>
        ))}
      </div>

      {selected ? (
        <div className="mt-3 space-y-1">
          {selected.description ? (
            <p className="text-xs leading-5 text-slate-500">{selected.description}</p>
          ) : null}
          {selected.keywords && selected.keywords.length > 0 ? (
            <div className="mt-2 flex flex-wrap gap-2">
              {selected.keywords.slice(0, 6).map((keyword) => (
                <span
                  key={keyword}
                  className="rounded bg-slate-100 px-2 py-1 text-xs text-slate-600"
                >
                  {keyword}
                </span>
              ))}
            </div>
          ) : null}
          {selected.basis ? (
            <p className="text-xs leading-5 text-slate-500">生成依据：{selected.basis}</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
