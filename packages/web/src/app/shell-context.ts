import { createContext, useContext } from 'solid-js';
import type { ShellServices } from '../infra/services.ts';

/** The shell's own view of the services: the same object as `ServicesContext`, with the shell state. */
export const ShellContext = createContext<ShellServices>();

export function useShell(): ShellServices {
  const services = useContext(ShellContext);
  if (!services) throw new Error('ShellContext is not provided');
  return services;
}
