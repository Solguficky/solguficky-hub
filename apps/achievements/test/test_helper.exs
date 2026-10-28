# Уровень выбирает переменная, а не пропуск (testing-strategy.md): без неё
# идёт L0 и тесты с тегом :integration исключены, с
# ACHIEVEMENTS_INTEGRATION_TESTS=1 — все уровни, и для L1 тест сам поднимает
# PostgreSQL и NATS в Testcontainers. Docker нужен только L1.
#
# Пропуск и недобор до порога роняют прогон: правило живёт здесь, а не в
# рецепте, чтобы его нёс и прямой `mix test` в каталоге компонента. Добавил или удалил тест —
# поправь порог своего уровня тем же изменением.
integration? = System.get_env("ACHIEVEMENTS_INTEGRATION_TESTS") == "1"
minimum = if integration?, do: 80, else: 60

ExUnit.after_suite(fn %{total: total, skipped: skipped} = result ->
  ran = total - skipped - Map.get(result, :excluded, 0)

  cond do
    skipped > 0 ->
      IO.puts(:stderr, "achievements: #{skipped} test(s) skipped — a skip is not a pass")
      System.halt(1)

    ran < minimum ->
      IO.puts(
        :stderr,
        "achievements: #{ran} test(s) ran, minimum is #{minimum} — a level lost its tests"
      )

      System.halt(1)

    true ->
      :ok
  end
end)

if integration? do
  ExUnit.start()
else
  ExUnit.start(exclude: [:integration])
end
