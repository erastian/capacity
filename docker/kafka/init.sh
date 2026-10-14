#!/bin/bash
set -euo pipefail

BOOTSTRAP="${KAFKA_BOOTSTRAP:-kafka:29092}"
CONFIG=/etc/capacity-kafka/admin.properties
BIN=/opt/kafka/bin

until "$BIN/kafka-broker-api-versions.sh" --bootstrap-server "$BOOTSTRAP" --command-config "$CONFIG" >/dev/null 2>&1; do
  echo "waiting for kafka at $BOOTSTRAP"
  sleep 1
done

topic() {
  "$BIN/kafka-topics.sh" --bootstrap-server "$BOOTSTRAP" --command-config "$CONFIG" \
    --create --if-not-exists --topic "$1" --partitions "$2" --replication-factor 1 "${@:3}"
}

topic treasury.program-capacity 6 --config message.timestamp.type=LogAppendTime
topic treasury.fx-rates 3 --config message.timestamp.type=LogAppendTime
topic capacity.reservation-events 6
topic capacity.message-status 6
topic capacity.dlq 3

acl() {
  "$BIN/kafka-acls.sh" --bootstrap-server "$BOOTSTRAP" --command-config "$CONFIG" --add "$@" >/dev/null
}

acl --allow-principal User:treasury --operation Write --operation Describe --topic treasury. --resource-pattern-type prefixed
acl --allow-principal User:treasury --operation Read --operation Describe --topic capacity.reservation-events
acl --allow-principal User:treasury --operation Read --operation Describe --topic capacity.message-status
acl --allow-principal User:treasury --operation Read --group treasury --resource-pattern-type prefixed

acl --allow-principal User:capacity --operation Read --operation Describe --topic treasury. --resource-pattern-type prefixed
acl --allow-principal User:capacity --operation Write --operation Describe --topic capacity. --resource-pattern-type prefixed
acl --allow-principal User:capacity --operation Read --topic capacity.dlq
acl --allow-principal User:capacity --operation Read --group capacity --resource-pattern-type prefixed

acl --allow-principal User:consumer --operation Read --operation Describe --topic capacity.reservation-events
acl --allow-principal User:consumer --operation Read --operation Describe --topic capacity.message-status
acl --allow-principal User:consumer --operation Read --operation Describe --topic capacity.dlq
acl --allow-principal User:consumer --operation Read --group consumer --resource-pattern-type prefixed

echo "topics and ACLs ready"
