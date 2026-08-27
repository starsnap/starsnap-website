import type { ReactNode } from 'react';
import type { ModuleId } from '../lib/erp-types';

interface SkeletonBlockProps {
  className?: string;
}

interface LoadingRegionProps {
  children: ReactNode;
  className?: string;
  label: string;
}

const moduleTableLayouts: Partial<Record<ModuleId, { columns: number; minWidth: number }>> = {
  partners: { columns: 6, minWidth: 820 },
  bids: { columns: 8, minWidth: 940 },
  'channel-orders': { columns: 9, minWidth: 1120 },
  meals: { columns: 8, minWidth: 940 },
  purchasing: { columns: 8, minWidth: 900 },
  inventory: { columns: 7, minWidth: 900 },
  production: { columns: 7, minWidth: 760 },
  delivery: { columns: 8, minWidth: 940 },
  settlement: { columns: 7, minWidth: 820 },
  haccp: { columns: 8, minWidth: 940 },
};

export function SkeletonBlock({ className = '' }: SkeletonBlockProps) {
  return (
    <span
      aria-hidden="true"
      className={`block animate-pulse rounded-[var(--ss-radius-sm)] bg-[var(--ss-border)] motion-reduce:animate-none ${className}`}
    />
  );
}

export function LoadingRegion({ children, className = '', label }: LoadingRegionProps) {
  return (
    <div role="status" aria-live="polite" aria-atomic="true" aria-busy="true" className={className}>
      <span className="sr-only">{label}</span>
      <div aria-hidden="true">{children}</div>
    </div>
  );
}

export function AuthSessionSkeleton() {
  return (
    <LoadingRegion label="로그인 상태를 확인하고 있습니다." className="mt-5">
      <SkeletonBlock className="mx-auto h-5 w-32" />
      <SkeletonBlock className="mx-auto mt-3 h-4 w-52 max-w-full" />
    </LoadingRegion>
  );
}

function MetricSkeletons({ count = 4 }: { count?: number }) {
  return (
    <div className={`grid gap-3 sm:grid-cols-2 ${count === 4 ? 'xl:grid-cols-4' : 'sm:grid-cols-3'}`}>
      {Array.from({ length: count }, (_, index) => (
        <article key={index} className="min-h-[126px] rounded-[var(--ss-radius-lg)] border border-[var(--ss-border)] bg-[var(--ss-surface)] p-5 shadow-[var(--ss-shadow-sm)]">
          <div className="flex items-center justify-between gap-4">
            <SkeletonBlock className="h-4 w-24" />
            <SkeletonBlock className="h-9 w-9 rounded-[var(--ss-radius-sm)]" />
          </div>
          <SkeletonBlock className="mt-4 h-8 w-28" />
          <SkeletonBlock className="mt-3 h-3 w-36 max-w-full" />
        </article>
      ))}
    </div>
  );
}

function TableSkeleton({
  columns = 8,
  minWidth = 900,
  rows = 6,
}: {
  columns?: number;
  minWidth?: number;
  rows?: number;
}) {
  const gridStyle = {
    gridTemplateColumns: `repeat(${columns}, minmax(96px, 1fr))`,
    minWidth,
  };
  return (
    <section className="panel overflow-hidden p-0">
      <div className="flex items-center justify-between gap-4 border-b border-[var(--ss-border)] px-5 py-4">
        <div className="min-w-0 flex-1">
          <SkeletonBlock className="h-5 w-40 max-w-full" />
          <SkeletonBlock className="mt-2 h-3 w-72 max-w-[80%]" />
        </div>
        <SkeletonBlock className="h-6 w-16 rounded-full" />
      </div>
      <div className="border-b border-[var(--ss-border)] bg-[var(--ss-surface-subtle)] px-5 py-2 lg:hidden">
        <SkeletonBlock className="h-3 w-48 max-w-full" />
      </div>
      <div className="overflow-x-auto">
        <div className="grid gap-5 border-b border-[var(--ss-border)] bg-[var(--ss-surface-subtle)] px-5 py-3" style={gridStyle}>
          {Array.from({ length: columns }, (_, index) => <SkeletonBlock key={index} className="h-3 w-16" />)}
        </div>
        {Array.from({ length: rows }, (_, row) => (
          <div key={row} className="grid gap-5 border-b border-[var(--ss-border)] px-5 py-4 last:border-b-0" style={gridStyle}>
            {Array.from({ length: columns }, (_, column) => (
              <SkeletonBlock key={column} className={`h-4 ${column === 0 ? 'w-28' : column === columns - 1 ? 'w-16 rounded-full' : 'w-20'}`} />
            ))}
          </div>
        ))}
      </div>
    </section>
  );
}

function SidePanelSkeleton() {
  return (
    <section className="panel min-h-[300px]">
      <SkeletonBlock className="h-3 w-24" />
      <SkeletonBlock className="mt-3 h-5 w-32" />
      <SkeletonBlock className="mt-5 h-36 w-full rounded-[var(--ss-radius-lg)]" />
      <SkeletonBlock className="mt-4 h-4 w-full" />
      <SkeletonBlock className="mt-2 h-4 w-4/5" />
    </section>
  );
}

function DashboardSkeleton() {
  return (
    <div className="space-y-5">
      <MetricSkeletons />
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.45fr)_minmax(340px,0.75fr)]">
        <section className="panel min-h-[292px]">
          <SkeletonBlock className="h-3 w-24" />
          <SkeletonBlock className="mt-2 h-5 w-36" />
          <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {Array.from({ length: 4 }, (_, index) => (
              <div key={index} className="rounded-[var(--ss-radius-md)] border border-[var(--ss-border)] p-4">
                <SkeletonBlock className="h-8 w-8 rounded-full" />
                <SkeletonBlock className="mt-4 h-4 w-20" />
                <SkeletonBlock className="mt-3 h-6 w-16" />
                <SkeletonBlock className="mt-4 h-1.5 w-full rounded-full" />
              </div>
            ))}
          </div>
        </section>
        <SidePanelSkeleton />
      </div>
      <div className="grid gap-4 md:grid-cols-3">
        {Array.from({ length: 3 }, (_, index) => (
          <div key={index} className="flex min-h-[108px] items-center gap-4 rounded-[var(--ss-radius-lg)] border border-[var(--ss-border)] bg-[var(--ss-surface)] p-4 shadow-[var(--ss-shadow-sm)]">
            <SkeletonBlock className="h-11 w-11 shrink-0 rounded-[var(--ss-radius-md)]" />
            <div className="min-w-0 flex-1"><SkeletonBlock className="h-4 w-28" /><SkeletonBlock className="mt-3 h-3 w-full" /></div>
          </div>
        ))}
      </div>
    </div>
  );
}

function ProductModuleSkeleton() {
  return (
    <div className="space-y-4">
      <section className="panel overflow-hidden p-0">
        <div className="flex flex-col gap-4 border-b border-[var(--ss-border)] p-5 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0 flex-1"><SkeletonBlock className="h-3 w-28" /><SkeletonBlock className="mt-2 h-6 w-44" /><SkeletonBlock className="mt-3 h-4 w-80 max-w-full" /></div>
          <div className="flex gap-2"><SkeletonBlock className="h-11 w-28" /><SkeletonBlock className="h-11 w-24" /></div>
        </div>
        <div className="flex flex-col gap-3 border-b border-[var(--ss-border)] bg-[var(--ss-surface-subtle)] px-5 py-4 sm:flex-row sm:items-end sm:justify-between">
          <div><SkeletonBlock className="h-3 w-20" /><SkeletonBlock className="mt-2 h-11 w-48" /></div>
          <SkeletonBlock className="h-4 w-64 max-w-full" />
        </div>
        <div className="grid gap-3 p-5 md:grid-cols-[minmax(220px,1fr)_200px_160px]">
          <SkeletonBlock className="h-11 w-full" /><SkeletonBlock className="h-11 w-full" /><SkeletonBlock className="h-11 w-full" />
        </div>
      </section>
      <ProductResultsSkeleton announce={false} />
    </div>
  );
}

export function ProductResultsSkeleton({ announce = true }: { announce?: boolean }) {
  const content = (
    <>
      <div className="grid gap-3 lg:hidden">
        {Array.from({ length: 3 }, (_, index) => (
          <article key={index} className="rounded-[var(--ss-radius-lg)] border border-[var(--ss-border)] bg-[var(--ss-surface)] p-4 shadow-[var(--ss-shadow-sm)]">
            <div className="flex items-start justify-between gap-3"><div className="flex-1"><SkeletonBlock className="h-3 w-20" /><SkeletonBlock className="mt-2 h-5 w-40 max-w-full" /><SkeletonBlock className="mt-3 h-4 w-28" /></div><SkeletonBlock className="h-6 w-16 rounded-full" /></div>
            <div className="mt-4 grid grid-cols-2 gap-4 border-y border-[var(--ss-border)] py-4"><SkeletonBlock className="h-10 w-full" /><SkeletonBlock className="h-10 w-full" /><SkeletonBlock className="h-10 w-full" /><SkeletonBlock className="h-10 w-full" /></div>
            <div className="mt-3 grid gap-2 sm:grid-cols-3"><SkeletonBlock className="h-24 w-full" /><SkeletonBlock className="h-24 w-full" /><SkeletonBlock className="h-24 w-full" /></div>
            <div className="mt-4 grid grid-cols-3 gap-2"><SkeletonBlock className="h-11 w-full" /><SkeletonBlock className="h-11 w-full" /><SkeletonBlock className="h-11 w-full" /></div>
          </article>
        ))}
      </div>
      <div className="hidden lg:block"><TableSkeleton columns={10} minWidth={1320} rows={6} /></div>
    </>
  );
  return announce
    ? <LoadingRegion label="상품 검색 결과를 불러오고 있습니다." className="space-y-3">{content}</LoadingRegion>
    : <div className="space-y-3">{content}</div>;
}

export function ModuleLoadingSkeleton({ activeModule }: { activeModule: ModuleId }) {
  const activeTableLayout = moduleTableLayouts[activeModule] ?? { columns: 8, minWidth: 900 };
  const content = activeModule === 'dashboard'
    ? <DashboardSkeleton />
    : activeModule === 'products'
      ? <ProductModuleSkeleton />
      : (
        <div className="space-y-4">
          {['purchasing', 'settlement'].includes(activeModule) ? <MetricSkeletons count={3} /> : null}
          {['partners', 'bids', 'production', 'haccp'].includes(activeModule) ? (
            <div className="grid gap-4 xl:grid-cols-[minmax(0,1.25fr)_330px]"><TableSkeleton {...activeTableLayout} /><SidePanelSkeleton /></div>
          ) : <TableSkeleton {...activeTableLayout} />}
        </div>
      );

  return <LoadingRegion label="회사별 운영 데이터를 불러오고 있습니다.">{content}</LoadingRegion>;
}
