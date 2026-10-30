// Web worker: runs the car simulation off the main thread so a few thousand cars never cost the map a frame.
import { CarRunner } from './cars-runner';
import type { FromWorker, ToWorker } from './cars-protocol';

interface WorkerScope {
  postMessage(message: FromWorker, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent<ToWorker>) => void) | null;
}
const scope = self as unknown as WorkerScope;
const runner = new CarRunner((message, transfer) => scope.postMessage(message, transfer ?? []));
scope.onmessage = (event) => runner.handle(event.data);
setInterval(() => runner.tick(performance.now()), 40);
