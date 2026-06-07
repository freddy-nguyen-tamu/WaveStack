import { useRef } from "react";
import { Upload } from "lucide-react";

type UploadButtonProps = {
  onUpload: (file: File) => void;
  className?: string;
};

export function UploadButton({ onUpload, className = "" }: UploadButtonProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  function handleChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    onUpload(file);
    if (inputRef.current) {
      inputRef.current.value = "";
    }
  }

  return (
    <label className={`upload-button ${className}`}>
      <Upload aria-hidden="true" />
      <span>Upload</span>
      <input
        ref={inputRef}
        type="file"
        accept="audio/*"
        onChange={handleChange}
        style={{ display: "none" }}
      />
    </label>
  );
}
