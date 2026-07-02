export function chatShellGridClass() {
  return 'md:grid-cols-[auto_minmax(0,1fr)]'
}

export function chatSessionPanelWidthClass(sessionRailCollapsed: boolean) {
  return sessionRailCollapsed
    ? 'md:w-16'
    : 'md:w-[clamp(280px,24vw,360px)]'
}

export function citationDetailLabel(type: string) {
  return type === 'DATABASE' ? 'Lihat kueri SQL' : 'Lihat detail sumber'
}
