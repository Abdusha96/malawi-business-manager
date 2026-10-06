import { TableSkeleton } from "@/components/erp/data-table";

// Module 82: shown inside the shell while any signed-in page loads, instead of a blank screen.
export default function Loading() {
  return (
    <main className="mx-auto max-w-6xl p-4 sm:p-6">
      <div className="mb-4 h-6 w-48 animate-pulse rounded bg-erp-subtle" />
      <TableSkeleton />
    </main>
  );
}
