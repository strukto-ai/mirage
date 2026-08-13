import os

runner = os.getenv("MIRAGE_RUNNER", "unknown")
squares = [n * n for n in range(1, 11)]
print("hello from a script stored in Slack")
print("runner:", runner)
print("sum of squares 1..10:", sum(squares))
