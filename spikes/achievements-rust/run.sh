#!/bin/sh
# Сценарии спайка. Нужны контейнеры rust-nats (4223) и rust-pg (5433), PY — python с protobuf и nats-py.
set -eu
PY=${PY:-python3}
psql() { docker exec -i rust-pg psql -U postgres -p 5433 -At "$@"; }
reset() {
  $PY reset.py
  psql -c 'DROP TABLE IF EXISTS cursor, processed, rule_state, grant_, outbox'
}
wait_for() { i=0; until grep -q "$2" "$1"; do i=$((i+1)); [ $i -gt 600 ] && exit 1; sleep 0.1; done; }
case "$1" in
scenario)  # тот же сценарий, что у Gleam-спайка: задачи под наблюдателем, один процесс
  reset; $PY publish_facts.py 1
  RUST_BACKTRACE=0 ./target/${PROFILE:-debug}/scenario > scenario.log 2>&1 &
  wait_for scenario.log "PHASE2 DONE"; $PY publish_facts.py 3
  wait_for scenario.log "SCENARIO DONE"; cat scenario.log
  echo "--- processed per achievement (46 unique event_id, 48 messages: 2 relay repeats deduped)"
  psql -c "SELECT achievement, count(*) FROM processed GROUP BY 1 ORDER BY 1" ;;
process-kill)  # kill -9 всего процесса посреди потока, перезапуск процесса
  reset; $PY publish_facts.py 1
  SLOW_MS=80 ./target/${PROFILE:-debug}/serve collector,first_bidder,bidder > serve1.log 2>&1 &
  pid=$!; sleep 2.5; echo "cursors before kill -9:"; psql -c 'SELECT achievement, seq FROM cursor ORDER BY 1'
  kill -9 $pid; wait $pid 2>/dev/null || true; echo "killed $pid"
  ./target/${PROFILE:-debug}/serve collector,first_bidder,bidder > serve2.log 2>&1 &
  pid=$!
  until [ "$(psql -c 'SELECT count(*) FROM cursor WHERE seq >= 42')" = 3 ]; do sleep 0.2; done; sleep 1
  kill $pid; echo "--- serve1"; cat serve1.log; echo "--- serve2"; cat serve2.log
  echo "--- cursors"; psql -c 'SELECT achievement, seq FROM cursor ORDER BY 1'
  echo "--- collector counts"; psql -c "SELECT right(subject,1), count FROM rule_state ORDER BY 1"
  echo "--- grants per achievement"; psql -c 'SELECT achievement, count(*) FROM grant_ GROUP BY 1 ORDER BY 1'
  echo "--- outbox unpublished"; psql -c 'SELECT count(*) FROM outbox WHERE NOT published' ;;
esac
