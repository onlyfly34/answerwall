/**
 * A starting value for the device name field, from what the browser says
 * about itself. Only a convenience: the user can type anything.
 */
export function suggestDeviceName(userAgent: string): string {
  // iPadOS reports itself as a Mac; the order matters for the others too.
  const platforms: [RegExp, string][] = [
    [/iPhone/, 'iPhone'],
    [/iPad/, 'iPad'],
    [/Android/, 'Android'],
    [/Windows/, 'Windows PC'],
    [/Macintosh|Mac OS X/, 'Mac'],
    [/CrOS/, 'Chromebook'],
    [/Linux/, 'Linux PC'],
  ];
  return platforms.find(([pattern]) => pattern.test(userAgent))?.[1] ?? 'Browser';
}
