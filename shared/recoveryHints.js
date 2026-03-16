function navigatorSignature() {
  if (typeof navigator === 'undefined') {
    return '';
  }
  const platformFromUserAgentData = navigator.userAgentData?.platform ?? '';
  return `${navigator.userAgent ?? ''} ${navigator.platform ?? ''} ${platformFromUserAgentData}`.trim();
}

export function getRecoveryReloadHint() {
  const signature = navigatorSignature();

  if (/Mac|iPhone|iPad|iPod/i.test(signature)) {
    return 'After clearing storage, press Command+Shift+R to hard refresh.';
  }
  if (/Windows/i.test(signature)) {
    return 'After clearing storage, press Ctrl+Shift+R to hard refresh.';
  }
  if (/Linux|X11|CrOS/i.test(signature)) {
    return 'After clearing storage, press Ctrl+Shift+R to hard refresh.';
  }
  return 'After clearing storage, hard refresh the page (Ctrl+Shift+R or Command+Shift+R on Mac).';
}
