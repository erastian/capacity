import { type Connection, type CreationEvent, instancesChannel } from '@platformatic/kafka';

instancesChannel.subscribe((event) => {
  const { type, instance } = event as CreationEvent<Connection>;
  if (type === 'connection') instance.on('error', () => undefined);
});
