import { useRef } from "react";
import { Upload } from "lucide-react";

type UploadButtonProps = {
  onUpload?: (file: File) => void;
  onUploadFiles?: (files: File[]) => void;
  className?: string;
  label?: string;
  multiple?: boolean;
};

export function UploadButton({
  onUpload,
  onUploadFiles,
  className = "",
  label = "Choose audio file",
  multiple = false
}: UploadButtonProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  function openFilePicker() {
    inputRef.current?.click();
  }

  function handleChange(event: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);

    if (!files.length) {
      return;
    }

    onUploadFiles?.(files);

    if (!onUploadFiles && onUpload) {
      for (const file of files) {
        onUpload(file);
      }
    }

    if (inputRef.current) {
      inputRef.current.value = "";
    }
  }

  return (
    <>
      <button type="button" className={`upload-button ${className}`.trim()} onClick={openFilePicker}>
        <Upload aria-hidden="true" />
        {label}
      </button>
      <input
        ref={inputRef}
        type="file"
        accept="audio/*,.mp3,.m4a,.wav,.flac,.aac,.ogg,.opus,.webm,.mp4"
        multiple={multiple}
        onChange={handleChange}
        className="sr-only"
        aria-hidden="true"
        tabIndex={-1}
      />
    </>
  );
}
