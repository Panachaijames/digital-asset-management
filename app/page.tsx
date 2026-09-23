import { Suspense } from "react";
import AppShell from "@/components/AppShell";
import ImageUploader from "@/components/ImageUploader";

export default async function Home(props: {
  searchParams?: Promise<{ folder?: string }>;
}) {
  const params = await props.searchParams;
  const folder = params?.folder;

  return (
    <AppShell crumb="Upload">
      <div className="h-full overflow-y-auto">
        <Suspense fallback={<div className="p-8 text-xs text-muted">Loading uploader…</div>}>
          <ImageUploader initialFolderPath={folder} />
        </Suspense>
      </div>
    </AppShell>
  );
}

