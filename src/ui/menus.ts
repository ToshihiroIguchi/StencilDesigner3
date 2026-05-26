export function toggleZoomMenu(e: MouseEvent): void {
  const menu = document.getElementById('zoom-menu');
  if (!menu) return;
  if (menu.hidden) {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    menu.style.left = `${rect.left}px`;
    menu.style.bottom = `${window.innerHeight - rect.top + 4}px`;
    menu.hidden = false;
  } else {
    menu.hidden = true;
  }
}

export function closeZoomMenu(): void {
  const menu = document.getElementById('zoom-menu');
  if (menu) menu.hidden = true;
}

export function toggleFileMenu(e: MouseEvent): void {
  const menu = document.getElementById('file-menu');
  if (!menu) return;
  if (menu.hidden) {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    menu.style.left = `${rect.left}px`;
    menu.style.top = `${rect.bottom + 4}px`;
    menu.hidden = false;
  } else {
    menu.hidden = true;
  }
}

export function closeFileMenu(): void {
  const menu = document.getElementById('file-menu');
  if (menu) menu.hidden = true;
}
