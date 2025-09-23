import * as core from '@actions/core'
import * as github from '@actions/github'
import { GitHubClient } from './github-client.js'

/**
 * DevEx metrics collection class - independent from DORA metrics
 */
export class DevExMetricsCollector {
  /**
   * Create a new DevEx metrics collector
   * @param {GitHubClient} githubClient - GitHub API client
   * @param {Object} options - Configuration options
   */
  constructor(githubClient, options = {}) {
    this.githubClient = githubClient
    this.options = {
      filesToIgnore: [],
      ignoreLineDeletions: false,
      ignoreFileDeletions: false,
      ...options
    }
  }

  /**
   * Collect all DevEx metrics for the current PR
   * @returns {Promise<Object>} Complete DevEx metrics data
   */
  async collectMetrics() {
    try {
      const prNumber = this.getPRNumber()
      if (!prNumber) {
        return {
          error: 'No PR context found - DevEx metrics require a pull request'
        }
      }

      core.info(`Collecting DevEx metrics for PR #${prNumber}`)

      // Collect PR size metrics
      const prSizeMetrics = await this.calculatePRSize(prNumber)

      return {
        pr_number: prNumber,
        metrics: {
          pr_size: prSizeMetrics
        },
        timestamp: new Date().toISOString()
      }
    } catch (error) {
      core.error(`DevEx metrics collection failed: ${error.message}`)
      return {
        error: error.message
      }
    }
  }

  /**
   * Get the current PR number from GitHub context
   * @returns {number|null} PR number or null if not in PR context
   */
  getPRNumber() {
    // Check if we're in a pull request event
    if (
      github.context.eventName === 'pull_request' ||
      github.context.eventName === 'pull_request_target'
    ) {
      return github.context.payload.pull_request?.number
    }

    // Check if we're in a workflow_run event triggered by a PR
    if (github.context.eventName === 'workflow_run') {
      return github.context.payload.workflow_run?.pull_requests?.[0]?.number
    }

    return null
  }

  /**
   * Calculate PR size metrics
   * @param {number} prNumber - Pull request number
   * @returns {Promise<Object>} PR size metrics
   */
  async calculatePRSize(prNumber) {
    try {
      const prDetails = await this.githubClient.getPullRequest(prNumber)
      const prFiles = await this.githubClient.getPullRequestFiles(prNumber)

      if (!prFiles || prFiles.length === 0) {
        return {
          size: 'xs',
          category: 'size/xs',
          details: {
            total_additions: 0,
            total_deletions: 0,
            total_changes: 0,
            files_changed: 0,
            files_analyzed: 0
          }
        }
      }

      // Filter files based on ignore patterns
      const filteredFiles = this.filterFiles(prFiles)

      // Calculate size metrics
      const sizeDetails = this.calculateSizeDetails(filteredFiles)
      const sizeCategory = this.categorizePRSize(sizeDetails)

      return {
        size: sizeCategory,
        category: `size/${sizeCategory}`,
        details: sizeDetails
      }
    } catch (error) {
      core.warning(`Failed to calculate PR size: ${error.message}`)
      return {
        size: 'unknown',
        category: 'size/unknown',
        details: {
          error: error.message
        }
      }
    }
  }

  /**
   * Filter files based on ignore patterns
   * @param {Array} files - Array of PR file objects
   * @returns {Array} Filtered files
   */
  filterFiles(files) {
    if (!this.options.filesToIgnore.length) {
      return files
    }

    return files.filter((file) => {
      // Check if file matches any ignore pattern
      const shouldIgnore = this.options.filesToIgnore.some((pattern) => {
        // Convert glob pattern to regex (basic implementation)
        const regexPattern = pattern.replace(/\*/g, '.*').replace(/\?/g, '.')
        const regex = new RegExp(`^${regexPattern}$`)
        return regex.test(file.filename)
      })

      if (shouldIgnore) {
        core.debug(`Ignoring file: ${file.filename}`)
        return false
      }

      // Check if we should ignore deleted files
      if (this.options.ignoreFileDeletions && file.status === 'removed') {
        core.debug(`Ignoring deleted file: ${file.filename}`)
        return false
      }

      return true
    })
  }

  /**
   * Calculate detailed size metrics from filtered files
   * @param {Array} files - Filtered PR files
   * @returns {Object} Size details
   */
  calculateSizeDetails(files) {
    let totalAdditions = 0
    let totalDeletions = 0
    let filesChanged = files.length

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

  /**
   * Categorize PR size based on change metrics
   * @param {Object} sizeDetails - Size details object
   * @returns {string} Size category (xs, s, m, l, xl)
   */
  categorizePRSize(sizeDetails) {
    const { total_changes } = sizeDetails

    // Define size thresholds based on common PR size conventions
    if (total_changes <= 10) return 'xs'
    if (total_changes <= 50) return 's'
    if (total_changes <= 200) return 'm'
    if (total_changes <= 500) return 'l'
    return 'xl'
  }

  /**
   * Add PR comment with size information
   * @param {number} prNumber - Pull request number
   * @param {Object} prSizeMetrics - PR size metrics
   * @returns {Promise<void>}
   */
  async addPRComment(prNumber, prSizeMetrics) {
    try {
      const { size, details } = prSizeMetrics
      const emoji = this.getSizeEmoji(size)

      const comment = `## ${emoji} PR Size: ${size.toUpperCase()}

This pull request has been automatically categorized as **${size}** based on the following metrics:

- **Lines added:** ${details.total_additions}
- **Lines removed:** ${details.total_deletions}
- **Total changes:** ${details.total_changes}
- **Files changed:** ${details.files_changed}

*This comment was generated automatically by the Agile Metrics Action.*`

      await this.githubClient.createPRComment(prNumber, comment)
      core.info(`Added size comment to PR #${prNumber}`)
    } catch (error) {
      core.warning(`Failed to add PR comment: ${error.message}`)
    }
  }

  /**
   * Add size label to PR
   * @param {number} prNumber - Pull request number
   * @param {string} sizeCategory - Size category (e.g., 'size/m')
   * @returns {Promise<void>}
   */
  async addPRLabel(prNumber, sizeCategory) {
    try {
      await this.githubClient.addPRLabel(prNumber, sizeCategory)
      core.info(`Added label '${sizeCategory}' to PR #${prNumber}`)
    } catch (error) {
      core.warning(`Failed to add PR label: ${error.message}`)
    }
  }

  /**
   * Get emoji for size category
   * @param {string} size - Size category
   * @returns {string} Emoji representation
   */
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
