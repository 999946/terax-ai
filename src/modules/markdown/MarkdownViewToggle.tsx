import { cn } from "@/lib/utils";
import type { MarkdownViewMode } from "@/modules/tabs";
import { useTranslation } from "react-i18next";

type Mode = MarkdownViewMode;

type Props = {
  mode: Mode;
  onChange: (mode: Mode) => void;
  renderedDisabled?: boolean;
  renderedHint?: string;
};

/** The order of buttons shown: rendered, split, raw. */
const MODES: { mode: Mode; i18nKey: string }[] = [
  { mode: "rendered", i18nKey: "markdown.viewRendered" },
  { mode: "split", i18nKey: "markdown.viewSplit" },
  { mode: "raw", i18nKey: "markdown.viewRaw" },
];

export function MarkdownViewToggle({
  mode,
  onChange,
  renderedDisabled,
  renderedHint,
}: Props) {
  const { t } = useTranslation();

  return (
    <div className="absolute right-3 top-3 z-10 inline-flex items-center gap-0.5 rounded-md border border-border/60 bg-card/85 p-0.5 text-[11px] shadow-sm backdrop-blur">
      {MODES.map(({ mode: m, i18nKey }) => {
        const isPreview = m !== "raw";
        const disabled = isPreview && renderedDisabled;
        return (
          <button
            key={m}
            type="button"
            onClick={() => onChange(m)}
            disabled={disabled}
            title={disabled ? renderedHint : undefined}
            className={cn(
              "rounded px-2 py-0.5 transition-colors",
              mode === m
                ? "bg-accent text-foreground"
                : "text-muted-foreground hover:text-foreground",
              disabled && "cursor-not-allowed opacity-40 hover:text-muted-foreground",
            )}
          >
            {t(i18nKey)}
          </button>
        );
      })}
    </div>
  );
}
