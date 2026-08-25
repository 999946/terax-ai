import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useDcpStore } from "@/modules/dcp";
import type { DcpPlugin } from "@/modules/dcp/types";
import { SectionHeader } from "../components/SectionHeader";

type Pending = { action: "edit"; plugin: DcpPlugin } | { action: "add" };

export function DcpSettings() {
  const { t } = useTranslation();
  const { snapshot: s, load, register, setEnabled, delete: remove } = useDcpStore();
  const [edit, setEdit] = useState<DcpPlugin | null>(null);
  const [original, setOriginal] = useState<DcpPlugin | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);

  useEffect(() => {
    void load();
  }, [load]);

  const dirty =
    !!edit &&
    !!original &&
    (edit.name !== original.name || edit.content !== original.content);

  const begin = (next: Pending) => {
    if (dirty) {
      setPending(next);
    } else if (next.action === "add") {
      const p: DcpPlugin = {
        id: crypto.randomUUID(),
        name: "",
        content: "",
        schemaVersion: 3,
        enabled: true,
      };
      setEdit(p);
      setOriginal(p);
    } else {
      setEdit({ ...next.plugin });
      setOriginal({ ...next.plugin });
    }
  };

  const save = async (next?: Pending) => {
    if (!edit?.name.trim()) return;
    await register(edit);
    setEdit(null);
    setOriginal(null);
    if (next) begin(next);
  };

  const discard = () => {
    const next = pending;
    setPending(null);
    setEdit(null);
    setOriginal(null);
    if (next) begin(next);
  };

  return (
    <div className="flex flex-col gap-5">
      <SectionHeader
        title={t("settings.dcp.title")}
        description={t("settings.dcp.description")}
      />
      <div className="rounded-lg border p-3">
        <Button size="xs" onClick={() => begin({ action: "add" })}>
          {t("settings.dcp.addPlugin")}
        </Button>

        {s?.plugins?.map((p: DcpPlugin) => (
          <div key={p.id} className="border-t py-2">
            <div className="flex gap-2">
              <span className="flex-1">{p.name}</span>
              <Button
                size="xs"
                variant="ghost"
                onClick={() => begin({ action: "edit", plugin: p })}
              >
                {t("settings.dcp.editPlugin")}
              </Button>
              <Button
                size="xs"
                variant="ghost"
                onClick={() => void remove(p.id)}
              >
                {t("settings.dcp.removePlugin")}
              </Button>
              <Switch
                checked={p.enabled}
                onCheckedChange={(v) => void setEnabled(p.id, v)}
              />
            </div>

            {edit?.id === p.id && (
              <div className="mt-3 grid gap-2">
                <Input
                  placeholder={t("settings.dcp.pluginName")}
                  value={edit.name}
                  onChange={(e) =>
                    setEdit({ ...edit, name: e.target.value })
                  }
                />
                <textarea
                  className="min-h-96 w-full resize-y rounded border p-3 font-mono text-xs leading-relaxed"
                  placeholder={t("settings.dcp.pluginScript")}
                  value={edit.content}
                  onChange={(e) =>
                    setEdit({ ...edit, content: e.target.value })
                  }
                />
                <div className="flex gap-2">
                  <Button size="xs" onClick={() => void save()}>
                    {t("settings.dcp.save")}
                  </Button>
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() => {
                      setEdit(null);
                      setOriginal(null);
                    }}
                  >
                    {t("settings.dcp.cancel")}
                  </Button>
                </div>
              </div>
            )}
          </div>
        ))}

        {edit && edit.id && !s?.plugins?.some((p) => p.id === edit.id) && (
          <div className="mt-3 grid gap-2">
            <Input
              placeholder={t("settings.dcp.pluginName")}
              value={edit.name}
              onChange={(e) => setEdit({ ...edit, name: e.target.value })}
            />
            <textarea
              className="min-h-96 w-full resize-y rounded border p-3 font-mono text-xs leading-relaxed"
              placeholder={t("settings.dcp.pluginScript")}
              value={edit.content}
              onChange={(e) => setEdit({ ...edit, content: e.target.value })}
            />
            <div className="flex gap-2">
              <Button size="xs" onClick={() => void save()}>
                {t("settings.dcp.save")}
              </Button>
              <Button
                size="xs"
                variant="ghost"
                onClick={() => {
                  setEdit(null);
                  setOriginal(null);
                }}
              >
                {t("settings.dcp.cancel")}
              </Button>
            </div>
          </div>
        )}

        {pending && (
          <div
            role="dialog"
            className="mt-4 rounded border bg-background p-4 shadow"
          >
            <p className="mb-3 text-sm">
              {t("settings.dcp.saveBeforeSwitching")}
            </p>
            <div className="flex gap-2">
              <Button
                size="xs"
                onClick={() => {
                  const next = pending;
                  setPending(null);
                  void save(next);
                }}
              >
                {t("settings.dcp.saveAndSwitch")}
              </Button>
              <Button size="xs" variant="outline" onClick={discard}>
                {t("settings.dcp.discardChanges")}
              </Button>
              <Button
                size="xs"
                variant="ghost"
                onClick={() => setPending(null)}
              >
                {t("settings.dcp.cancel")}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
