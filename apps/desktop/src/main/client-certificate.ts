/**
 * TLS client certificates. A server may ask the client to identify itself
 * with a certificate, and Electron answers with the first one in the user's
 * certificate store unless a listener of `select-client-certificate` decides
 * otherwise. Such a certificate can be a company or smart-card identity that
 * names its owner, and it would go to whatever address was typed into the
 * connection page. This app has no use for one: none is ever offered.
 */

/** The part of Electron's `app` used here; tests pass a stand-in. */
export interface ClientCertificateSource {
  on(
    event: 'select-client-certificate',
    listener: (
      event: { preventDefault(): void },
      contents: unknown,
      url: unknown,
      list: unknown,
      callback: (certificate?: never) => void,
    ) => void,
  ): unknown;
}

/** Answers every request for a client certificate with "none". */
export function refuseClientCertificates(app: ClientCertificateSource): void {
  app.on('select-client-certificate', (event, _contents, _url, _list, callback) => {
    // Without this, Electron picks the first certificate by itself.
    event.preventDefault();
    callback();
  });
}
