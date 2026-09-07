import { LoaderCircle } from "lucide-react";

export function LoadingStatus({ label = "Loading..." }: { label?: string }) {
  return <p className="loading-status" role="status"><LoaderCircle aria-hidden="true" />{label}</p>;
}
