export function chatShellGridClass() {
  return 'md:grid-cols-[auto_minmax(0,1fr)]'
}

export function chatSessionPanelWidthClass(sessionRailCollapsed: boolean) {
  return sessionRailCollapsed
    ? 'md:w-12'
    : 'md:w-[clamp(200px,18vw,260px)]'
}

export function citationDetailLabel(type: string) {
  return type === 'DATABASE' ? 'Lihat kueri SQL' : 'Lihat detail sumber'
}
