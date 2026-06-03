import {
  ArrowRight01Icon,
  Csv01Icon,
  Delete02Icon,
  Doc01Icon,
  File02Icon,
  FileAudioIcon,
  FileCodeIcon,
  FileImageIcon,
  FileVideoIcon,
  Folder01Icon,
  HtmlFile01Icon,
  JavaScriptIcon,
  Pdf01Icon,
  Ppt01Icon,
  Txt01Icon,
  Xls01Icon,
  Zip01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { useRef, useState, type ReactNode } from "react";

import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { cn } from "./lib/utils";
import { LoadingView } from "./loading-view";
import { PageTransition, useDepthPageDirection } from "./page-transition";
import type { LibraryFile, LibraryFolder, LibraryPage } from "./web-types";

function formatFileSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(size < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

function getFileExtension(filename: string): string {
  const index = filename.lastIndexOf(".");
  return index >= 0 ? filename.slice(index + 1).toLowerCase() : "";
}

function getLibraryFileIcon(file: LibraryFile): IconSvgElement {
  const mimeType = file.mimeType.toLowerCase();
  const extension = getFileExtension(file.filename);
  if (mimeType.startsWith("image/")) return FileImageIcon;
  if (mimeType.startsWith("video/")) return FileVideoIcon;
  if (mimeType.startsWith("audio/")) return FileAudioIcon;
  if (mimeType === "application/pdf" || extension === "pdf") return Pdf01Icon;
  if (["zip", "gz", "tar", "rar", "7z"].includes(extension) || mimeType.includes("zip") || mimeType.includes("archive")) return Zip01Icon;
  if (["xls", "xlsx", "ods"].includes(extension) || mimeType.includes("spreadsheet") || mimeType.includes("excel")) return Xls01Icon;
  if (["ppt", "pptx", "odp"].includes(extension) || mimeType.includes("presentation") || mimeType.includes("powerpoint")) return Ppt01Icon;
  if (extension === "csv" || mimeType === "text/csv") return Csv01Icon;
  if (["txt", "md", "rtf"].includes(extension) || mimeType.startsWith("text/")) return Txt01Icon;
  if (["html", "htm"].includes(extension) || mimeType === "text/html") return HtmlFile01Icon;
  if (["js", "jsx", "ts", "tsx"].includes(extension)) return JavaScriptIcon;
  if (["json", "css", "xml", "yml", "yaml", "toml", "sh", "py", "rb", "go", "rs", "java", "c", "cpp", "cs"].includes(extension)) return FileCodeIcon;
  if (["doc", "docx", "odt"].includes(extension) || mimeType.includes("word")) return Doc01Icon;
  return File02Icon;
}

export function LibrarySheet(props: {
  page: LibraryPage | null;
  loading: boolean;
  saving: boolean;
  onOpenFolder: (folderId: string | null) => void;
  onCreateFolder: (name: string, parentId: string | null) => void;
  onUploadFile: (file: File, folderId: string | null) => void;
  onMoveFile: (fileId: string, folderId: string | null) => void;
  onDeleteFile: (file: LibraryFile) => void;
  onDeleteFolder: (folder: LibraryFolder) => void;
  SheetComponent: (props: { title: string; children: ReactNode; onBack?: () => void; backLabel?: string; locked?: boolean; className?: string }) => ReactNode;
}) {
  const [folderName, setFolderName] = useState("");
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const SheetComponent = props.SheetComponent;
  const currentFolderId = props.page?.folder?.id ?? null;
  const folderOptions = props.page ? [props.page.folder, ...props.page.folders].filter((folder): folder is LibraryFolder => Boolean(folder)) : [];
  const hasItems = Boolean(props.page && (props.page.folders.length > 0 || props.page.files.length > 0));
  const folderDepth = props.page ? props.page.breadcrumbs.length + (props.page.folder ? 1 : 0) : 0;
  const folderDirection = useDepthPageDirection(folderDepth);

  function createFolder() {
    const name = folderName.trim();
    if (!name) return;
    props.onCreateFolder(name, currentFolderId);
    setFolderName("");
  }

  return (
    <SheetComponent title="Library" onBack={props.page?.folder ? () => props.onOpenFolder(props.page?.folder?.parentId ?? null) : undefined} backLabel="Back to parent folder">
      <div className="library-sheet-body">
        <div className="library-toolbar">
          <div className="library-path" aria-label="Current folder">
            <button type="button" onClick={() => props.onOpenFolder(null)}>Library</button>
            {props.page?.breadcrumbs.map((folder) => (
              <button key={folder.id} type="button" onClick={() => props.onOpenFolder(folder.id)}>
                <HugeiconsIcon icon={ArrowRight01Icon} size={14} strokeWidth={2} aria-hidden="true" />
                <span>{folder.name}</span>
              </button>
            ))}
          </div>
          <div className="library-actions">
            <input
              ref={fileInputRef}
              className="profile-image-input"
              type="file"
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                event.currentTarget.value = "";
                if (file) props.onUploadFile(file, currentFolderId);
              }}
            />
            <Button className="library-action-button" type="button" disabled={props.saving} onClick={() => fileInputRef.current?.click()}>
              Upload
            </Button>
          </div>
        </div>
        <div className="library-create-row">
          <Input
            className="library-folder-input"
            value={folderName}
            placeholder="New folder"
            aria-label="New folder name"
            onChange={(event) => setFolderName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                createFolder();
              }
            }}
          />
          <Button className="library-action-button" type="button" disabled={props.saving || !folderName.trim()} onClick={createFolder}>
            Create
          </Button>
        </div>
        <PageTransition pageKey={currentFolderId ?? "root"} direction={folderDirection} className="library-page-slide">
          {props.loading ? <LoadingView label="Loading Library..." /> : null}
          {!props.loading && props.page ? (
            <div className="library-list">
              {props.page.folders.map((folder, index) => (
                <div key={folder.id} className={cn("library-row", index > 0 && "library-row-joined", index < props.page!.folders.length - 1 && "library-row-joins-next")}>
                  <button className="library-row-main" type="button" onClick={() => props.onOpenFolder(folder.id)}>
                    <span className="library-icon-wrap">
                      <HugeiconsIcon icon={Folder01Icon} size={34} strokeWidth={1.7} aria-hidden="true" />
                    </span>
                    <span className="library-item-copy">
                      <strong>{folder.name}</strong>
                      <small>Folder</small>
                    </span>
                    <HugeiconsIcon className="library-row-arrow" icon={ArrowRight01Icon} size={18} strokeWidth={2.1} aria-hidden="true" />
                  </button>
                  <button className="library-delete-button" type="button" aria-label={`Delete ${folder.name}`} disabled={props.saving} onClick={() => props.onDeleteFolder(folder)}>
                    <HugeiconsIcon icon={Delete02Icon} size={18} strokeWidth={2} aria-hidden="true" />
                  </button>
                </div>
              ))}
              {props.page.files.map((file, index) => (
                <div key={file.id} className={cn("library-row library-file-row", props.page!.folders.length + index > 0 && "library-row-joined", index < props.page!.files.length - 1 && "library-row-joins-next")}>
                  <a className="library-row-main" href={file.url} target="_blank" rel="noreferrer">
                    <span className={cn("library-icon-wrap", file.mimeType.startsWith("image/") && "library-image-preview")}>
                      {file.mimeType.startsWith("image/") ? (
                        <img src={file.url} alt="" loading="lazy" />
                      ) : (
                        <HugeiconsIcon icon={getLibraryFileIcon(file)} size={34} strokeWidth={1.7} aria-hidden="true" />
                      )}
                    </span>
                    <span className="library-item-copy">
                      <strong>{file.filename}</strong>
                      <small>{file.mimeType} · {formatFileSize(file.size)}</small>
                    </span>
                  </a>
                  <select
                    className="library-folder-select"
                    aria-label={`Move ${file.filename}`}
                    value={file.folderId ?? ""}
                    disabled={props.saving}
                    onChange={(event) => props.onMoveFile(file.id, event.currentTarget.value || null)}
                  >
                    <option value="">Library</option>
                    {folderOptions.map((folder) => (
                      <option key={folder.id} value={folder.id}>{folder.name}</option>
                    ))}
                  </select>
                  <button className="library-delete-button" type="button" aria-label={`Delete ${file.filename}`} disabled={props.saving} onClick={() => props.onDeleteFile(file)}>
                    <HugeiconsIcon icon={Delete02Icon} size={18} strokeWidth={2} aria-hidden="true" />
                  </button>
                </div>
              ))}
              {!hasItems ? <p className="empty-state">No files in this folder yet.</p> : null}
            </div>
          ) : null}
        </PageTransition>
      </div>
    </SheetComponent>
  );
}
