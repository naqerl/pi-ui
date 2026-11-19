import { useCallback, useRef } from "react";
import { ATTACH_ACCEPT } from "./media-client";

export function useMediaPicker(
  onFiles: (files: File[]) => void,
  options: { testId?: string } = {},
) {
  const inputRef = useRef<HTMLInputElement>(null);
  const open = useCallback(() => inputRef.current?.click(), []);
  const input = (
    <input
      ref={inputRef}
      type="file"
      accept={ATTACH_ACCEPT}
      multiple
      hidden
      data-testid={options.testId ?? "attach-input"}
      onChange={(event) => {
        const files = event.target.files;
        if (files !== null) onFiles([...files]);
        event.target.value = "";
      }}
    />
  );
  return { input, open };
}
