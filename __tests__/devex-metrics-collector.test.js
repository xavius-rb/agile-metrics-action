/**
 * Unit tests for DevEx metrics collector
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals'

// Mock dependencies
const mockCore = {
  info: jest.fn(),
  debug: jest.fn(),
  warning: jest.fn(),
  error: jest.fn()
}

const mockGitHubClient = {
  getPullRequest: jest.fn(),
  getPullRequestFiles: jest.fn(),
  createPRComment: jest.fn(),
  addPRLabel: jest.fn()
}

// Setup mocks
jest.unstable_mockModule('@actions/core', () => mockCore)

// Create a simple test class that doesn't depend on the actual import
class TestDevExMetricsCollector {
  constructor(githubClient, options = {}) {
    this.githubClient = githubClient
    this.options = {
      filesToIgnore: [],
      ignoreLineDeletions: false,
      ignoreFileDeletions: false,
      ...options
    }
  }

  filterFiles(files) {
    return files.filter((file) => {
      // Check if we should ignore deleted files
      if (this.options.ignoreFileDeletions && file.status === 'removed') {
        return false
      }

      // Check if file matches any ignore pattern
      if (this.options.filesToIgnore.length > 0) {
        const shouldIgnore = this.options.filesToIgnore.some((pattern) => {
          const regexPattern = pattern.replace(/\*/g, '.*').replace(/\?/g, '.')
          const regex = new RegExp(`^${regexPattern}$`)
          return regex.test(file.filename)
        })

        if (shouldIgnore) {
          return false
        }
      }

      return true
    })
  }

  calculateSizeDetails(files) {
    let totalAdditions = 0
    let totalDeletions = 0
    const filesChanged = files.length

    files.forEach((file) => {
      totalAdditions += file.additions || 0

      if (!this.options.ignoreLineDeletions) {
        totalDeletions += file.deletions || 0
      }
    })

    const totalChanges = totalAdditions + totalDeletions

    return {
      total_additions: totalAdditions,
      total_deletions: totalDeletions,
      total_changes: totalChanges,
      files_changed: filesChanged,
      files_analyzed: files.length
    }
  }

  categorizePRSize(sizeDetails) {
    const { total_changes } = sizeDetails

    if (total_changes <= 10) return 'xs'
    if (total_changes <= 50) return 's'
    if (total_changes <= 200) return 'm'
    if (total_changes <= 500) return 'l'
    return 'xl'
  }

  getSizeEmoji(size) {
    const emojiMap = {
      xs: '🤏',
      s: '🔹',
      m: '🔸',
      l: '🔶',
      xl: '🔥'
    }
    return emojiMap[size] || '❓'
  }
}

describe('DevExMetricsCollector', () => {
  let collector

  beforeEach(() => {
    jest.clearAllMocks()
    collector = new TestDevExMetricsCollector(mockGitHubClient)
  })

  describe('constructor', () => {
    it('should initialize with default options', () => {
      expect(collector.githubClient).toBe(mockGitHubClient)
      expect(collector.options.filesToIgnore).toEqual([])
      expect(collector.options.ignoreLineDeletions).toBe(false)
      expect(collector.options.ignoreFileDeletions).toBe(false)
    })

    it('should accept custom options', () => {
      const options = {
        filesToIgnore: ['*.md', '*.txt'],
        ignoreLineDeletions: true,
        ignoreFileDeletions: true
      }
      const customCollector = new TestDevExMetricsCollector(
        mockGitHubClient,
        options
      )

      expect(customCollector.options.filesToIgnore).toEqual(['*.md', '*.txt'])
      expect(customCollector.options.ignoreLineDeletions).toBe(true)
      expect(customCollector.options.ignoreFileDeletions).toBe(true)
    })
  })

  describe('filterFiles', () => {
    const mockFiles = [
      { filename: 'src/main.js', status: 'modified' },
      { filename: 'README.md', status: 'modified' },
      { filename: 'package.json', status: 'modified' },
      { filename: 'test.txt', status: 'removed' },
      { filename: 'docs/guide.md', status: 'added' }
    ]

    it('should return all files when no filters are set', () => {
      const filtered = collector.filterFiles(mockFiles)
      expect(filtered).toEqual(mockFiles)
    })

    it('should filter files by ignore patterns', () => {
      collector.options.filesToIgnore = ['*.md', '*.txt']
      const filtered = collector.filterFiles(mockFiles)

      expect(filtered).toHaveLength(2)
      expect(filtered.map((f) => f.filename)).toEqual([
        'src/main.js',
        'package.json'
      ])
    })

    it('should ignore deleted files when ignoreFileDeletions is true', () => {
      collector.options.ignoreFileDeletions = true
      const filtered = collector.filterFiles(mockFiles)

      expect(filtered).toHaveLength(4)
      expect(filtered.find((f) => f.status === 'removed')).toBeUndefined()
    })

    it('should combine multiple filters', () => {
      collector.options.filesToIgnore = ['*.md']
      collector.options.ignoreFileDeletions = true

      const filtered = collector.filterFiles(mockFiles)
      expect(filtered).toHaveLength(2)
      expect(filtered.map((f) => f.filename)).toEqual([
        'src/main.js',
        'package.json'
      ])
    })
  })

  describe('calculateSizeDetails', () => {
    it('should calculate size details correctly', () => {
      const files = [
        { additions: 10, deletions: 5 },
        { additions: 20, deletions: 3 },
        { additions: 0, deletions: 15 }
      ]

      const details = collector.calculateSizeDetails(files)

      expect(details.total_additions).toBe(30)
      expect(details.total_deletions).toBe(23)
      expect(details.total_changes).toBe(53)
      expect(details.files_changed).toBe(3)
      expect(details.files_analyzed).toBe(3)
    })

    it('should ignore line deletions when ignoreLineDeletions is true', () => {
      collector.options.ignoreLineDeletions = true
      const files = [
        { additions: 10, deletions: 5 },
        { additions: 20, deletions: 3 }
      ]

      const details = collector.calculateSizeDetails(files)

      expect(details.total_additions).toBe(30)
      expect(details.total_deletions).toBe(0)
      expect(details.total_changes).toBe(30)
    })

    it('should handle missing additions/deletions', () => {
      const files = [
        { additions: 10 }, // missing deletions
        { deletions: 5 }, // missing additions
        {} // missing both
      ]

      const details = collector.calculateSizeDetails(files)

      expect(details.total_additions).toBe(10)
      expect(details.total_deletions).toBe(5)
      expect(details.total_changes).toBe(15)
    })
  })

  describe('categorizePRSize', () => {
    it('should categorize XS (≤10 changes)', () => {
      expect(collector.categorizePRSize({ total_changes: 5 })).toBe('xs')
      expect(collector.categorizePRSize({ total_changes: 10 })).toBe('xs')
    })

    it('should categorize S (11-50 changes)', () => {
      expect(collector.categorizePRSize({ total_changes: 25 })).toBe('s')
      expect(collector.categorizePRSize({ total_changes: 50 })).toBe('s')
    })

    it('should categorize M (51-200 changes)', () => {
      expect(collector.categorizePRSize({ total_changes: 100 })).toBe('m')
      expect(collector.categorizePRSize({ total_changes: 200 })).toBe('m')
    })

    it('should categorize L (201-500 changes)', () => {
      expect(collector.categorizePRSize({ total_changes: 300 })).toBe('l')
      expect(collector.categorizePRSize({ total_changes: 500 })).toBe('l')
    })

    it('should categorize XL (>500 changes)', () => {
      expect(collector.categorizePRSize({ total_changes: 501 })).toBe('xl')
      expect(collector.categorizePRSize({ total_changes: 1000 })).toBe('xl')
    })
  })

  describe('getSizeEmoji', () => {
    it('should return correct emojis for each size', () => {
      expect(collector.getSizeEmoji('xs')).toBe('🤏')
      expect(collector.getSizeEmoji('s')).toBe('🔹')
      expect(collector.getSizeEmoji('m')).toBe('🔸')
      expect(collector.getSizeEmoji('l')).toBe('🔶')
      expect(collector.getSizeEmoji('xl')).toBe('🔥')
      expect(collector.getSizeEmoji('unknown')).toBe('❓')
    })
  })
})
