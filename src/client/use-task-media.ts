import { useEffect, useRef, useState } from "react";
import { TASK_ATTACHMENTS_MAX } from "../shared/tasks";
import type { Task, TaskLedger } from "../shared/types";
import { uploadMedia } from "./media-client";
import { useMediaPicker } from "./media-picker";
import { updateTask } from "./task-client";

interface PendingImage {
  key: string;
  preview: string;
  name: string;
}

export interface ViewerImage {
  id: string;
  alt: string;
}

let pendingKey = 0;

/**
 * The task detail's image list: upload through the shared picker, patch the task,
 * and keep the visible list optimistic while the ledger catches up.
 */
export function useTaskMedia(task: Task, onLedger?: (ledger: TaskLedger) => void) {
  const [pending, setPending] = useState<PendingImage[]>([]);
  const [removed, setRemoved] = useState<Set<string>>(() => new Set());
  const [viewer, setViewer] = useState<ViewerImage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const taskRef = useRef(task);
  taskRef.current = task;
  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  const onLedgerRef = useRef(onLedger);
  onLedgerRef.current = onLedger;
  const live = useRef(true);
  const working = useRef(false);
  const mediaTaskId = useRef(task.id);

  useEffect(
    () => () => {
      live.current = false;
      for (const item of pendingRef.current) URL.revokeObjectURL(item.preview);
    },
    [],
  );

  // A different task starts with no uploads, removals or open viewer from the last one.
  useEffect(() => {
    if (mediaTaskId.current === task.id) return;
    mediaTaskId.current = task.id;
    for (const item of pendingRef.current) URL.revokeObjectURL(item.preview);
    pendingRef.current = [];
    setPending([]);
    setRemoved(new Set());
    setViewer(null);
    setError(null);
    setBusy(false);
    working.current = false;
  }, [task.id]);

  // Removing is immediate: once the ledger changes there is nothing left to hide.
  // The new list also settles a failed removal, an empty clear, or the same
  // content-addressed id being added back after the last image was removed.
  const saved = task.attachments;
  const lastSaved = useRef(saved);
  useEffect(() => {
    if (lastSaved.current === saved) return;
    lastSaved.current = saved;
    setRemoved((current) => (current.size === 0 ? current : new Set()));
  }, [saved]);

  const attachments = (saved ?? []).filter((id) => !removed.has(id));

  const save = async (taskId: string, ids: string[]): Promise<boolean> => {
    const outcome = await updateTask(taskId, { attachments: ids });
    if (!live.current) return outcome.ok;
    if (!outcome.ok) {
      setError(outcome.error);
      return false;
    }
    setError(null);
    onLedgerRef.current?.(outcome.ledger);
    return true;
  };

  const remove = async (id: string) => {
    if (working.current) return;
    const taskId = taskRef.current.id;
    working.current = true;
    setBusy(true);
    setError(null);
    setRemoved((current) => new Set(current).add(id));
    try {
      const next = (taskRef.current.attachments ?? []).filter((item) => item !== id);
      const ok = await save(taskId, next);
      if (!ok && live.current && taskRef.current.id === taskId) {
        setRemoved((current) => {
          const copy = new Set(current);
          copy.delete(id);
          return copy;
        });
      }
    } finally {
      working.current = false;
      if (live.current) setBusy(false);
    }
  };

  const add = async (files: File[]) => {
    if (working.current) return;
    const taskId = taskRef.current.id;
    const images = files.filter((file) => file.type.startsWith("image/"));
    if (images.length === 0) return;
    const current = taskRef.current.attachments ?? [];
    const room =
      TASK_ATTACHMENTS_MAX -
      current.filter((id) => !removed.has(id)).length -
      pendingRef.current.length;
    if (room <= 0) {
      setError(`At most ${TASK_ATTACHMENTS_MAX} images can be attached`);
      return;
    }
    const chosen = images.slice(0, room);
    const entries = chosen.map((file) => ({
      key: `m${++pendingKey}`,
      preview: URL.createObjectURL(file),
      name: file.name,
    }));
    working.current = true;
    setBusy(true);
    setError(null);
    setPending((items) => [...items, ...entries]);
    pendingRef.current = [...pendingRef.current, ...entries];
    try {
      const ids: string[] = [];
      for (let index = 0; index < chosen.length; index++) {
        const file = chosen[index];
        if (file === undefined) continue;
        try {
          ids.push((await uploadMedia(file)).id);
        } catch (uploadError) {
          if (live.current) {
            setError(uploadError instanceof Error ? uploadError.message : "Upload failed");
          }
        }
      }
      if (ids.length === 0 || !live.current || taskRef.current.id !== taskId) return;
      const latest = taskRef.current.attachments ?? [];
      const next = [...latest.filter((id) => !removed.has(id)), ...ids];
      await save(taskId, [...new Set(next)]);
    } finally {
      for (const entry of entries) URL.revokeObjectURL(entry.preview);
      pendingRef.current = pendingRef.current.filter(
        (item) => !entries.some((entry) => entry.key === item.key),
      );
      if (live.current) {
        setPending((items) =>
          items.filter((item) => !entries.some((entry) => entry.key === item.key)),
        );
      }
      working.current = false;
      if (live.current) setBusy(false);
    }
  };

  const picker = useMediaPicker((files) => void add(files), { testId: "task-media-input" });

  return {
    attachments,
    pending,
    busy,
    error,
    viewer,
    atLimit: attachments.length + pending.length >= TASK_ATTACHMENTS_MAX,
    input: picker.input,
    open: picker.open,
    add,
    remove,
    setViewer,
    dismissError: () => setError(null),
  };
}

export type TaskMedia = ReturnType<typeof useTaskMedia>;
