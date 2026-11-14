# Standard library

This page is generated from the doc strings in `src/runtime/stdlib.ts` by `npm run docs`. Do not edit it by hand.

Every function can be called two ways. `len(xs)` and `xs.len()` are the same call: `value.f(args)` passes
`value` as the first argument. Pipelines do the same: `xs |> map(f)` is `map(xs, f)`.

Constants: `PI`, `E`, `INF`. Constructors: `Some(value)`, `None`, `Ok(value)`, `Err(error)`.

## Core

| Function | Description |
| --- | --- |
| `print(values...)` | write values separated by spaces |
| `str(value)` | convert to a string |
| `repr(value)` | string with quotes, as the REPL shows it |
| `num(value)` | parse a number; nil if it is not one |
| `int(n)` | truncate towards zero |
| `type(value)` | the type name |
| `len(x)` | length of a list, string, map or range |
| `assert(condition, message?)` | fail when the condition is false |
| `assert_eq(actual, expected, message?)` | fail when not equal |
| `error(message)` | an error value; use with `throw error("...")` |
| `clock()` | milliseconds since 1970 |

## Lists

| Function | Description |
| --- | --- |
| `push(list, values...)` | append, return the list |
| `pop(list)` | remove and return the last item |
| `insert(list, index, value)` | insert before index |
| `remove_at(list, index)` | remove and return an item |
| `first(xs)` | first item, or nil |
| `last(xs)` | last item, or nil |
| `slice(xs, start, end?)` | a part of a list or string |
| `reverse(xs)` | reversed copy |
| `contains(xs, value)` | membership; substring for strings; key for maps |
| `index_of(xs, value)` | position, or -1 |
| `sort(xs, key?)` | sorted copy, optionally by a key function |
| `list(xs)` | a new list from any iterable |
| `range(end) / range(start, end, step?)` | list of numbers |
| `flatten(xs)` | concatenate a list of lists |
| `unique(xs)` | items without duplicates, in order |
| `take(xs, n)` | the first n items |
| `drop(xs, n)` | everything after the first n items |
| `chunks(xs, size)` | split into lists of at most size items |
| `zip(a, b)` | list of [a_i, b_i] pairs |
| `enumerate(xs)` | list of [index, item] pairs |

## Higher-order

| Function | Description |
| --- | --- |
| `map(xs, f)` | apply f to every item |
| `filter(xs, f)` | items where f is truthy |
| `reduce(xs, f, initial)` | fold left with f(acc, item) |
| `each(xs, f)` | call f for every item |
| `find(xs, f)` | Some(first item where f is truthy), or None |
| `any(xs, f?)` | true if any item (or f(item)) is truthy |
| `all(xs, f?)` | true if every item (or f(item)) is truthy |
| `count(xs, f)` | number of items where f is truthy |
| `sum(xs)` | add numbers |
| `min(xs) or min(a, b, ...)` | smallest value |
| `max(xs) or max(a, b, ...)` | largest value |
| `group_by(xs, f)` | map from str(f(item)) to the items with that key |

## Strings

| Function | Description |
| --- | --- |
| `split(text, separator?)` | split on a separator, or on whitespace |
| `join(xs, separator?)` | join items into a string |
| `upper(text)` |  |
| `lower(text)` |  |
| `trim(text)` | remove surrounding whitespace |
| `starts_with(text, prefix)` |  |
| `ends_with(text, suffix)` |  |
| `replace(text, old, new)` | replace every occurrence |
| `chars(text)` | list of characters |
| `lines(text)` | list of lines |
| `pad_left(value, width, fill?)` |  |
| `pad_right(value, width, fill?)` |  |
| `code(char)` | Unicode code point |
| `char(code)` | character for a code point |
| `fixed(n, digits)` | format with a fixed number of decimals |

## Maps

| Function | Description |
| --- | --- |
| `keys(map)` |  |
| `values(map)` |  |
| `entries(map)` | list of [key, value] pairs |
| `has(map, key)` |  |
| `get(collection, key, default?)` | a map value or list item, or the default when it is missing |
| `delete(map, key)` | remove a key, return the map |
| `merge(a, b)` | new map with the entries of both (b wins) |
| `copy(xs)` | shallow copy of a list or map |

## Math

| Function | Description |
| --- | --- |
| `abs(n)` |  |
| `floor(n)` |  |
| `ceil(n)` |  |
| `round(n, digits?)` |  |
| `sqrt(n)` |  |
| `sin(radians)` |  |
| `cos(radians)` |  |
| `atan2(y, x)` |  |
| `log(n)` | natural logarithm |
| `random()` | number in [0, 1) |
| `random_int(low, high)` | whole number in [low, high] |
| `choice(xs)` | a random item |
| `shuffle(xs)` | shuffled copy |

## Option and Result

| Function | Description |
| --- | --- |
| `unwrap(x)` | the value inside Some/Ok, or throw |
| `unwrap_or(x, default)` | value inside Some/Ok, or the default |
| `is_some(x)` |  |
| `is_ok(x)` |  |

## JSON

| Function | Description |
| --- | --- |
| `to_json(value, indent?)` | JSON text |
| `from_json(text)` | parse JSON into lists and maps |

