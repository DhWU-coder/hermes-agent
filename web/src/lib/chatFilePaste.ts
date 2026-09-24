import { authedFetch } from "@/lib/api";

const MAX_FILE_BYTES = 100 * 1024 * 1024;
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp"]);
const DOCUMENT_EXTENSIONS = new Set(["pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt", "md", "csv", "zip"]);

export interface ChatFileUploadResult {
  path: string;
  name: string;
  bytes: number;
}

export function isChatImage(file: File): boolean {
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  return file.type.startsWith("image/") || IMAGE_EXTENSIONS.has(extension);
}

export function clipboardHasOnlyFileNames(text: string): boolean {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines.length > 0 && lines.every((line) => {
    if (line.includes("/") || line.includes("\\")) return false;
    const extension = line.split(".").pop()?.toLowerCase() ?? "";
    return DOCUMENT_EXTENSIONS.has(extension);
  });
}

export function fileReference(path: string): string {
  if (!/[\s()[\]{}<>"'`]/.test(path)) return `@file:${path}`;
  for (const quote of ["`", '"', "'"]) {
    if (!path.includes(quote)) return `@file:${quote}${path}${quote}`;
  }
  throw new Error("File path contains unsupported quote characters");
}

/** 用分块上传保存浏览器中的文件字节，返回 TUI 可以引用的绝对路径。 */
export async function uploadChatFile(file: File, profile = ""): Promise<ChatFileUploadResult> {
  if (file.size > MAX_FILE_BYTES) throw new Error("File is too large (max 100 MB)");
  const form = new FormData();
  form.append("file", file, file.name);
  const qs = profile ? `?profile=${encodeURIComponent(profile)}` : "";
  const response = await authedFetch(`/api/chat/file-upload${qs}`, {
    method: "POST",
    body: form,
  });
  if (!response.ok) {
    throw new Error(await response.text().catch(() => response.statusText));
  }
  const result = (await response.json()) as ChatFileUploadResult;
  if (!result.path) throw new Error("File upload did not return a path");
  return result;
}
