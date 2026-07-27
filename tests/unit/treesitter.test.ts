/**
 * 测试: Tree-sitter 多语言代码骨架提取
 * 验证 Go/Python/Rust/Java 四种语言的 AST 解析和符号提取
 */

import { describe, it, expect } from 'bun:test'
import { parseWithTreeSitter } from '../../src/context/parsers/treesitter'

describe('Tree-sitter Go', () => {
  it('提取函数定义', async () => {
    const result = await parseWithTreeSitter(
      `package main

// Hello 返回问候语
func Hello(name string) string {
\treturn "Hello, " + name
}

func internal() {}`,
      'hello.go',
    )
    expect(result).not.toBeNull()
    expect(result!.symbols.length).toBeGreaterThanOrEqual(2)
    const hello = result!.symbols.find((s) => s.name === 'Hello')
    expect(hello).toBeDefined()
    expect(hello!.kind).toBe('function')
    expect(hello!.exports).toBe(true)
    const internal = result!.symbols.find((s) => s.name === 'internal')
    expect(internal!.exports).toBe(false)
  })

  it('提取方法和接口', async () => {
    const result = await parseWithTreeSitter(
      `package main

type Greeter interface {
\tGreet() string
}

type Person struct {
\tName string
}

func (p Person) Greet() string {
\treturn "Hi, " + p.Name
}`,
      'greeter.go',
    )
    expect(result).not.toBeNull()
    expect(result!.symbols.some((s) => s.name === 'Greeter' && s.kind === 'interface')).toBe(true)
    expect(result!.symbols.some((s) => s.name === 'Person' && s.kind === 'class')).toBe(true)
    expect(result!.symbols.some((s) => s.name === 'Greet' && s.kind === 'method')).toBe(true)
  })

  it('提取 import', async () => {
    const result = await parseWithTreeSitter(
      `package main\n\nimport "fmt"\nimport "os"\n\nfunc main() {}`,
      'main.go',
    )
    expect(result).not.toBeNull()
    expect(result!.imports).toContain('fmt')
    expect(result!.imports).toContain('os')
  })
})

describe('Tree-sitter Python', () => {
  it('提取函数和类', async () => {
    const result = await parseWithTreeSitter(
      `def helper():
    pass

class Calculator:
    def add(self, a, b):
        return a + b

    def multiply(self, a, b):
        return a * b

async def fetch_data(url):
    return await http.get(url)`,
      'calc.py',
    )
    expect(result).not.toBeNull()
    expect(result!.symbols.some((s) => s.name === 'helper' && s.kind === 'function')).toBe(true)
    expect(result!.symbols.some((s) => s.name === 'Calculator' && s.kind === 'class')).toBe(true)
    expect(result!.symbols.some((s) => s.name === 'add' && s.kind === 'method')).toBe(true)
    expect(result!.symbols.some((s) => s.name === 'fetch_data' && s.kind === 'function')).toBe(true)
  })

  it('检测私有符号', async () => {
    const result = await parseWithTreeSitter(
      `def public_func(): pass
def _private_func(): pass
class _PrivateClass:
    pass`,
      'module.py',
    )
    expect(result).not.toBeNull()
    const publicFunc = result!.symbols.find((s) => s.name === 'public_func')
    expect(publicFunc!.exports).toBe(true)
    const privateFunc = result!.symbols.find((s) => s.name === '_private_func')
    expect(privateFunc!.exports).toBe(false)
  })

  it('提取 import', async () => {
    const result = await parseWithTreeSitter(
      `import os\nfrom typing import List, Dict\n\nx = 1`,
      'util.py',
    )
    expect(result).not.toBeNull()
    expect(result!.imports.length).toBeGreaterThanOrEqual(2)
  })
})

describe('Tree-sitter Rust', () => {
  it('提取公有和私有函数', async () => {
    const result = await parseWithTreeSitter(
      `pub fn public_func() -> i32 { 42 }
fn private_func() { }

pub(crate) fn crate_func() { }

async fn async_func() -> Result<(), Error> {
    Ok(())
}`,
      'lib.rs',
    )
    expect(result).not.toBeNull()
    expect(result!.symbols.some((s) => s.name === 'public_func' && s.exports)).toBe(true)
    expect(result!.symbols.some((s) => s.name === 'private_func' && !s.exports)).toBe(true)
  })

  it('提取 struct/enum/trait/impl', async () => {
    const result = await parseWithTreeSitter(
      `pub struct Config {
    pub name: String,
}

enum Color {
    Red, Green, Blue,
}

pub trait Displayable {
    fn display(&self) -> String;
}

impl Displayable for Config {
    fn display(&self) -> String {
        self.name.clone()
    }
}`,
      'types.rs',
    )
    expect(result).not.toBeNull()
    expect(result!.symbols.some((s) => s.name === 'Config' && s.kind === 'class')).toBe(true)
    expect(result!.symbols.some((s) => s.name === 'Color')).toBe(true)
    expect(result!.symbols.some((s) => s.name === 'Displayable' && s.kind === 'interface')).toBe(true)
    expect(result!.symbols.some((s) => s.name === 'Config' && s.kind === 'class')).toBe(true)
  })

  it('提取 use 语句', async () => {
    const result = await parseWithTreeSitter(
      `use std::collections::HashMap;\nuse serde::{Serialize, Deserialize};\nfn main() {}`,
      'main.rs',
    )
    expect(result).not.toBeNull()
    expect(result!.imports.length).toBeGreaterThanOrEqual(2)
  })
})

describe('Tree-sitter Java', () => {
  it('提取类、接口和方法', async () => {
    const result = await parseWithTreeSitter(
      `package com.example;

public class UserService {
    public String getUser(long id) {
        return "user-" + id;
    }

    private void doInternal() {
    }
}

interface UserRepository {
    User findById(long id);
}`,
      'UserService.java',
    )
    expect(result).not.toBeNull()
    expect(result!.symbols.some((s) => s.name === 'UserService' && s.kind === 'class')).toBe(true)
    expect(result!.symbols.some((s) => s.name === 'UserRepository' && s.kind === 'interface')).toBe(true)
    const getUser = result!.symbols.find((s) => s.name === 'getUser')
    expect(getUser).toBeDefined()
    expect(getUser!.exports).toBe(true)
    const doInternal = result!.symbols.find((s) => s.name === 'doInternal')
    expect(doInternal!.exports).toBe(false)
  })

  it('提取 import', async () => {
    const result = await parseWithTreeSitter(
      `import java.util.List;\nimport java.util.ArrayList;\n\npublic class Foo {}`,
      'Foo.java',
    )
    expect(result).not.toBeNull()
    expect(result!.imports.length).toBeGreaterThanOrEqual(2)
  })
})
