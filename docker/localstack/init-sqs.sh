#!/usr/bin/env bash
set -euo pipefail

REGION="${AWS_DEFAULT_REGION:-us-east-1}"

echo "Creating SQS FIFO queues in LocalStack (${REGION})..."

awslocal sqs create-queue \
  --region "${REGION}" \
  --queue-name wager-transactions-dlq.fifo \
  --attributes '{"FifoQueue":"true","ContentBasedDeduplication":"false"}' >/dev/null

DLQ_URL=$(awslocal sqs get-queue-url --region "${REGION}" --queue-name wager-transactions-dlq.fifo --query 'QueueUrl' --output text)
DLQ_ARN=$(awslocal sqs get-queue-attributes --region "${REGION}" --queue-url "${DLQ_URL}" --attribute-names QueueArn --query 'Attributes.QueueArn' --output text)

awslocal sqs create-queue \
  --region "${REGION}" \
  --queue-name wager-transactions.fifo \
  --attributes "{\"FifoQueue\":\"true\",\"ContentBasedDeduplication\":\"false\",\"VisibilityTimeout\":\"30\",\"RedrivePolicy\":\"{\\\"deadLetterTargetArn\\\":\\\"${DLQ_ARN}\\\",\\\"maxReceiveCount\\\":\\\"5\\\"}\"}" >/dev/null

awslocal sqs create-queue \
  --region "${REGION}" \
  --queue-name wager-events.fifo \
  --attributes '{"FifoQueue":"true","ContentBasedDeduplication":"false"}' >/dev/null

echo "SQS FIFO queues ready."
