import { cn } from "@/lib/utils";
import { useTranslation } from "react-i18next";
import { DIFF_MODES, type DiffMode } from "./diffMode";

type Props = {
  mode: DiffMode;
  onChange: (mode: DiffMode) => void;
};

/** The order of buttons shown: split, inline. */
const MODES: { mode: DiffMode; i18nKey: string }[] = DIFF_MODES.map((m) => ({
  mode: m,
  i18nKey: m === "split" ? "editor.diffViewSplit" : "editor.diffViewInline",
}));

export function DiffViewToggle({ mode, onChange }: Props) {
  const { t } = useTranslation();

  return (
    <div className="absolute right-3 top-3 z-10 inline-flex items-center gap-0.5 rounded-md border border-border/60 bg-card/85 p-0.5 text-[11px] shadow-sm backdrop-blur">
      {MODES.map(({ mode: m, i18nKey }) => (
        <button
          key={m}
          type="button"
          onClick={() => onChange(m)}
          className={cn(
            "rounded px-2 py-0.5 transition-colors",
            mode === m
              ? "bg-accent text-foreground"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {t(i18nKey)}
        </button>
      ))}
    </div>
  );
}
